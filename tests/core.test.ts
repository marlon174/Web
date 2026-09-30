import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/core/config';
import { Game, NEUTRAL, type GameEvent, type GameSettings } from '../src/core/game';
import { TileHeap } from '../src/core/heap';
import { mapFromTerrain, Terrain } from '../src/core/map';
import { createMap, createSettings, type MatchOptions } from '../src/core/setup';

/** A plains map with optional water tiles, and two human players we control. */
function duel(width: number, height: number, water: [number, number][] = []): GameSettings {
  const terrain = new Uint8Array(width * height).fill(Terrain.Plains);
  for (const [x, y] of water) terrain[y * width + x] = Terrain.Water;
  return {
    seed: 42,
    map: mapFromTerrain(width, height, terrain),
    players: [
      { name: 'A', color: 0xff0000, bot: false },
      { name: 'B', color: 0x0000ff, bot: false },
    ],
    difficulty: 'normal',
    timeLimit: 0,
  };
}

function start(settings: GameSettings, a: [number, number], b: [number, number]): Game {
  const game = new Game(settings);
  const w = settings.map.width;
  game.queue({ type: 'spawn', player: 1, tile: a[1] * w + a[0] });
  game.queue({ type: 'spawn', player: 2, tile: b[1] * w + b[0] });
  game.step();
  expect(game.phase).toBe('play');
  return game;
}

function run(game: Game, ticks: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks && game.phase !== 'over'; i++) {
    game.step();
    events.push(...game.drainEvents());
  }
  return events;
}

const botMatch: MatchOptions = {
  seed: 1234,
  mode: 'quick',
  mapSize: 'small',
  bots: 6,
  difficulty: 'hard',
  human: { name: 'You', color: 0xd7263d },
};

/** Spawns the human on the first land tile in the middle row and has them expand every few seconds. */
function scriptedMatch(options: MatchOptions, ticks: number): Game {
  const map = createMap(options);
  const game = new Game(createSettings(options, map));
  const row = Math.floor(map.height / 2) * map.width;
  let tile = row;
  while (map.terrain[tile] !== Terrain.Plains) tile++;
  game.queue({ type: 'spawn', player: 1, tile });
  for (let i = 0; i < ticks; i++) {
    if (i % 40 === 5) game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 600 });
    game.step();
  }
  return game;
}

describe('TileHeap', () => {
  it('pops tiles in key order, breaking ties by tile', () => {
    const heap = new TileHeap(2);
    const items: [number, number][] = [[5, 10], [1, 99], [3, 7], [1, 4], [8, 0], [3, 2]];
    for (const [key, tile] of items) heap.push(key, tile);
    const popped: number[] = [];
    while (heap.size > 0) popped.push(heap.pop());
    expect(popped).toEqual([4, 99, 2, 7, 10, 0]);
  });
});

describe('determinism', () => {
  it('plays out identically from the same seed and intents', () => {
    const a = scriptedMatch(botMatch, 900);
    const b = scriptedMatch(botMatch, 900);
    expect(a.tick).toBe(b.tick);
    expect(a.hash()).toBe(b.hash());
  });

  it('plays out differently from a different seed', () => {
    const a = scriptedMatch(botMatch, 300);
    const b = scriptedMatch({ ...botMatch, seed: 99 }, 300);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('replays a match from its intent log', () => {
    const original = scriptedMatch(botMatch, 600);
    const replay = new Game(original.settings);
    let next = 0;
    while (replay.tick < original.tick) {
      while (next < original.log.length && original.log[next].tick === replay.tick) {
        replay.queue(original.log[next++].intent);
      }
      replay.step();
    }
    expect(replay.hash()).toBe(original.hash());
  });
});

describe('economy', () => {
  it('grows troops up to the cap and no further', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    run(game, 3000);
    expect(a.troops).toBeLessThanOrEqual(game.maxTroops(a));
    expect(a.troops).toBeGreaterThan(game.maxTroops(a) * 0.99);
  });

  it('spends troops to take neutral land', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    const tilesBefore = a.tiles;
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 500 });
    game.step();
    expect(a.troops).toBeLessThan(600);
    run(game, 60);
    expect(a.tiles).toBeGreaterThan(tilesBefore + 100);
  });
});

describe('combat', () => {
  it('cancels out two armies attacking each other', () => {
    // Spawn disks touch at x = 5 | 6.
    const game = start(duel(12, 5), [2, 2], [9, 2]);
    game.queue({ type: 'attack', player: 1, target: 2, permille: 500 });
    game.queue({ type: 'attack', player: 2, target: 1, permille: 500 });
    game.step();
    expect(game.attacks).toHaveLength(0);
    expect(game.player(1).tiles + game.player(2).tiles).toBeGreaterThan(0);
  });

  it('ignores attacks on players you do not border', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    game.queue({ type: 'attack', player: 1, target: 2, permille: 500 });
    game.step();
    expect(game.attacks).toHaveLength(0);
    expect(game.player(1).troops).toBeGreaterThan(1000);
  });

  it('takes the capital, then the whole player, and ends the match', () => {
    // A grows strong on open land to the left while B is boxed in on the right.
    // Water at x = 20 cuts off land nobody can reach, so A can't win on land share first.
    const moat = Array.from({ length: 7 }, (_, y): [number, number] => [20, y]);
    const game = start(duel(60, 7, moat), [50, 3], [57, 3]);
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    run(game, 900);
    const b = game.player(2);
    expect(game.player(1).troops).toBeGreaterThan(3 * b.troops);

    game.queue({ type: 'attack', player: 1, target: 2, permille: 1000 });
    const events = run(game, 400);
    expect(events).toContainEqual({ type: 'capitalLost', player: 2, by: 1 });
    expect(events).toContainEqual({ type: 'eliminated', player: 2, by: 1 });
    expect(game.phase).toBe('over');
    expect(game.winner).toBe(1);
    expect(b.place).toBe(2);
  });
});

describe('territory', () => {
  it('absorbs a neutral pocket enclosed by one player', () => {
    // (7, 7) is claimed by nobody at spawn, and water seals it in against A's land.
    const game = start(duel(40, 16, [[8, 7], [7, 8]]), [4, 5], [35, 10]);
    const pocket = 7 * 40 + 7;
    expect(game.owner[pocket]).toBe(1);
  });

  it('keeps every border list in sync with the map', () => {
    const game = scriptedMatch(botMatch, 1200);
    const { owner, width, size } = game;
    const land = game.map.terrain;
    for (const p of game.players) {
      const listed = new Set(p.border);
      expect(listed.size).toBe(p.border.length);
      for (let t = 0; t < size; t++) {
        if (owner[t] !== p.id) continue;
        const x = t % width;
        const touches = (n: number) => land[n] !== Terrain.Water && owner[n] !== p.id;
        const onBorder =
          (x > 0 && touches(t - 1)) ||
          (x < width - 1 && touches(t + 1)) ||
          (t >= width && touches(t - width)) ||
          (t + width < size && touches(t + width));
        expect(listed.has(t)).toBe(onBorder);
      }
    }
  });
});

describe('buildings', () => {
  it('builds a city for gold and raises the troop cap', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    const cap = game.maxTroops(a);
    a.gold = 5000;
    const tile = 5 * 40 + 4;
    game.queue({ type: 'build', player: 1, tile, kind: 'city' });
    game.step();
    expect(game.buildingAt(tile)).toMatchObject({ kind: 'city', owner: 1 });
    expect(a.gold).toBeLessThan(3100);
    expect(game.maxTroops(a)).toBeCloseTo(cap * 1.2);
    expect(game.buildCost(a, 'city')).toBe(3000);
  });

  it('refuses foreign land, crowded spots and empty purses', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    expect(game.canBuild(a, 'city', 5 * 40 + 4)).toBe('gold');
    a.gold = 1e6;
    expect(game.canBuild(a, 'city', 5 * 40 + 35)).toBe('notYours');
    game.queue({ type: 'build', player: 1, tile: 5 * 40 + 4, kind: 'city' });
    game.step();
    expect(game.canBuild(a, 'silo', 5 * 40 + 6)).toBe('tooClose');
  });

  it('hands a building to whoever takes its tile', () => {
    const moat = Array.from({ length: 7 }, (_, y): [number, number] => [20, y]);
    const game = start(duel(60, 7, moat), [50, 3], [57, 3]);
    const b = game.player(2);
    b.gold = 5000;
    game.queue({ type: 'build', player: 2, tile: 3 * 60 + 58, kind: 'city' });
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    run(game, 900);
    game.queue({ type: 'attack', player: 1, target: 2, permille: 1000 });
    const events = run(game, 400);
    expect(events).toContainEqual({ type: 'captured', kind: 'city', tile: 3 * 60 + 58, from: 2, by: 1 });
    expect(game.buildingAt(3 * 60 + 58)?.owner).toBe(1);
    expect(game.player(1).owned.city).toBe(1);
  });

  it('makes land around a defence post dearer to take', () => {
    const taken = (post: boolean) => {
      const game = start(duel(12, 5), [2, 2], [9, 2]);
      if (post) {
        game.player(2).gold = 5000;
        game.queue({ type: 'build', player: 2, tile: 2 * 12 + 9, kind: 'defense' });
        game.step();
      }
      const before = game.player(1).tiles;
      game.queue({ type: 'attack', player: 1, target: 2, permille: 1000 });
      run(game, 60);
      return game.player(1).tiles - before;
    };
    expect(taken(true)).toBeLessThan(taken(false));
  });
});

describe('missiles', () => {
  it('needs a silo and gold', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    expect(game.canLaunch(a, 'rocket')).toBe('noSilo');
    a.gold = 1e6;
    game.queue({ type: 'build', player: 1, tile: 5 * 40 + 4, kind: 'silo' });
    game.step();
    expect(game.canLaunch(a, 'rocket')).toBeNull();
  });

  it('flies, then wipes out land, buildings and troops in the blast', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    const b = game.player(2);
    a.gold = 1e6;
    b.gold = 5000;
    const target = 5 * 40 + 35;
    game.queue({ type: 'build', player: 1, tile: 5 * 40 + 4, kind: 'silo' });
    game.queue({ type: 'build', player: 2, tile: 5 * 40 + 34, kind: 'city' });
    game.step();
    game.queue({ type: 'launch', player: 1, tile: target, kind: 'nuke' });
    game.step();
    expect(game.missiles).toHaveLength(1);
    const events = run(game, CONFIG.missileMinFlight + 20);
    expect(game.missiles).toHaveLength(0);
    expect(events.some((e) => e.type === 'impact')).toBe(true);
    expect(events).toContainEqual({ type: 'eliminated', player: 2, by: 1 });
    expect(game.owner[target]).toBe(NEUTRAL);
    expect(game.buildingAt(5 * 40 + 34)).toBeUndefined();
    expect(game.fallout[target]).toBeGreaterThan(game.tick);
  });

  it('leaves a bombed hole open instead of absorbing it as a pocket', () => {
    // A's side (x < 26) stays under the 70% that would win outright.
    const moat = Array.from({ length: 12 }, (_, y): [number, number] => [26, y]);
    const game = start(duel(40, 12, moat), [4, 5], [35, 5]);
    const a = game.player(1);
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    run(game, 150);
    a.gold = 1e6;
    game.queue({ type: 'build', player: 1, tile: 5 * 40 + 4, kind: 'silo' });
    game.step();
    const hole = 6 * 40 + 20;
    expect(game.owner[hole]).toBe(1);
    game.queue({ type: 'launch', player: 1, tile: hole, kind: 'rocket' });
    run(game, CONFIG.missileMinFlight + 30);
    expect(game.owner[hole]).toBe(NEUTRAL);
  });
});

describe('prices', () => {
  it('rise by a fixed step and stop at a cap', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    a.owned.city = 20;
    expect(game.buildCost(a, 'city')).toBe(CONFIG.buildings.city.max);
    a.owned.city = 3;
    expect(game.buildCost(a, 'city')).toBe(CONFIG.buildings.city.cost + 3 * CONFIG.buildings.city.step);
  });
});

describe('factories and trains', () => {
  it('runs a train through your cities and pays gold at each', () => {
    const game = start(duel(60, 12), [10, 5], [55, 5]);
    const a = game.player(1);
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    run(game, 200);
    a.gold = 1e6;
    game.queue({ type: 'build', player: 1, tile: 5 * 60 + 4, kind: 'city' });
    game.queue({ type: 'build', player: 1, tile: 5 * 60 + 20, kind: 'city' });
    game.queue({ type: 'build', player: 1, tile: 5 * 60 + 12, kind: 'factory' });
    game.step();
    const factory = game.buildingAt(5 * 60 + 12)!;
    expect(game.railRoute(factory)).toHaveLength(2);
    const events = run(game, CONFIG.trainInterval + 200);
    const stops = events.filter((e) => e.type === 'trainStop');
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(stops[0]).toMatchObject({ owner: 1, gold: CONFIG.trainStopGold });
  });
});

describe('ports and boats', () => {
  // A strait at x = 20..23 separates A's land (left) from an island (right).
  const strait = Array.from({ length: 12 * 4 }, (_, i): [number, number] => [20 + (i % 4), Math.floor(i / 4)]);

  it('only builds ports on the coast', () => {
    const game = start(duel(40, 12, strait), [4, 5], [10, 5]);
    const a = game.player(1);
    a.gold = 1e6;
    expect(game.canBuild(a, 'port', 5 * 40 + 4)).toBe('notCoast');
  });

  it('sails troops across water and lands them', () => {
    const game = start(duel(40, 12, strait), [4, 5], [8, 1]);
    const a = game.player(1);
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    run(game, 150);
    a.gold = 1e6;
    game.queue({ type: 'build', player: 1, tile: 5 * 40 + 19, kind: 'port' });
    game.step();
    expect(game.buildingAt(5 * 40 + 19)?.kind).toBe('port');
    const island = 5 * 40 + 30;
    expect(typeof game.planBoat(a, island)).toBe('object');
    game.queue({ type: 'boat', player: 1, tile: island, permille: 800 });
    game.step();
    expect(game.boats).toHaveLength(1);
    const events = run(game, 60);
    expect(events.some((e) => e.type === 'landed')).toBe(true);
    let onIsland = 0;
    for (let t = 0; t < game.size; t++) if (t % 40 > 23 && game.owner[t] === 1) onIsland++;
    expect(onIsland).toBeGreaterThan(10);
  });
});

describe('alliances', () => {
  function withBot(): Game {
    const settings = duel(12, 5);
    settings.players[1].bot = true;
    const game = new Game(settings);
    game.queue({ type: 'spawn', player: 1, tile: 2 * 12 + 2 });
    game.step();
    return game;
  }

  it('stops allies from attacking each other until it ends', () => {
    const game = withBot();
    const bot = game.players[1];
    let accepted = false;
    for (let i = 0; i < 20 && !accepted; i++) {
      game.queue({ type: 'ally', player: 1, target: bot.id });
      accepted = run(game, 1).some((e) => e.type === 'alliance' && e.accepted);
      if (!accepted) run(game, CONFIG.allianceCooldown);
    }
    expect(accepted).toBe(true);
    expect(game.allied(1, bot.id)).toBe(true);
    if (game.sharesBorder(game.player(1), bot.id)) {
      game.queue({ type: 'attack', player: 1, target: bot.id, permille: 500 });
      game.step();
      expect(game.attacks.some((a) => a.attacker === 1 && a.target === bot.id)).toBe(false);
    }
    game.queue({ type: 'breakAlly', player: 1, target: bot.id });
    const events = run(game, 1);
    expect(events).toContainEqual({ type: 'allianceEnded', a: 1, b: bot.id, brokenBy: 1 });
    expect(game.allied(1, bot.id)).toBe(false);
  });
});

describe('bunkers', () => {
  it('are destroyed, not captured, when an enemy takes their tile', () => {
    const moat = Array.from({ length: 7 }, (_, y): [number, number] => [20, y]);
    const game = start(duel(60, 7, moat), [50, 3], [57, 3]);
    game.player(2).gold = 5000;
    game.queue({ type: 'build', player: 2, tile: 3 * 60 + 58, kind: 'defense' });
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    run(game, 900);
    expect(game.buildingAt(3 * 60 + 58)?.kind).toBe('defense');
    // Bunkers are tough: bring an overwhelming army.
    game.player(1).troops = 1e6;
    game.queue({ type: 'attack', player: 1, target: 2, permille: 1000 });
    const events = run(game, 600);
    expect(events).toContainEqual({ type: 'bunkerDestroyed', tile: 3 * 60 + 58, from: 2, by: 1 });
    expect(game.buildingAt(3 * 60 + 58)).toBeUndefined();
    expect(game.player(1).owned.defense).toBe(0);
  });
});

describe('silos', () => {
  it('reload for a while after each launch', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    a.gold = 1e6;
    game.queue({ type: 'build', player: 1, tile: 5 * 40 + 4, kind: 'silo' });
    game.step();
    game.queue({ type: 'launch', player: 1, tile: 5 * 40 + 20, kind: 'rocket' });
    game.step();
    expect(game.canLaunch(a, 'rocket')).toBe('reloading');
    run(game, CONFIG.siloReload);
    expect(game.canLaunch(a, 'rocket')).toBeNull();
  });
});

describe('recall', () => {
  it('calls an attack off and brings the troops home', () => {
    const game = start(duel(40, 12), [4, 5], [35, 5]);
    const a = game.player(1);
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 900 });
    game.step();
    const sent = game.attacks[0].troops;
    const home = a.troops;
    game.queue({ type: 'recall', player: 1, target: NEUTRAL });
    game.step();
    expect(game.attacks).toHaveLength(0);
    expect(a.troops).toBeGreaterThan(home + sent * 0.9);
  });
});
