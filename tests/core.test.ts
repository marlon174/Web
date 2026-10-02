import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/core/config';
import { Game, NEUTRAL, type GameEvent, type GameSettings } from '../src/core/game';
import { TileHeap } from '../src/core/heap';
import { mapFromTerrain, Terrain } from '../src/core/map';
import { REAL_MASKS } from '../src/core/realmap-data';
import { buildRealMap, decodeMask } from '../src/core/realmaps';
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
    // Water at x = 40 keeps A under the 70% that would win outright.
    const moat = Array.from({ length: 12 }, (_, y): [number, number] => [40, y]);
    const game = start(duel(60, 12, moat), [10, 5], [55, 5]);
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

  it('lets a human accept an offer from a bot, which lapses if ignored', () => {
    const game = withBot();
    const bot = game.players[1];
    game.queue({ type: 'ally', player: bot.id, target: 1 });
    expect(run(game, 1)).toContainEqual({ type: 'allianceOffer', from: bot.id, to: 1 });
    expect(game.allied(1, bot.id)).toBe(false);
    game.queue({ type: 'ally', player: 1, target: bot.id });
    expect(run(game, 1)).toContainEqual({ type: 'alliance', from: 1, to: bot.id, accepted: true });
    expect(game.allied(1, bot.id)).toBe(true);

    const other = withBot();
    other.queue({ type: 'ally', player: 2, target: 1 });
    run(other, CONFIG.allianceOfferTicks + 1);
    expect(other.hasOffer(2, 1)).toBe(false);
    // Too late: answering now counts as a fresh request, and the bot is still cooling off.
    other.queue({ type: 'ally', player: 1, target: 2 });
    expect(run(other, 1)).toContainEqual({ type: 'alliance', from: 1, to: 2, accepted: false });
  });
});

describe('warships', () => {
  // Two shores 16 tiles apart: A on the left, B on the right.
  function sea(): Game {
    const water: [number, number][] = [];
    for (let y = 0; y < 15; y++) for (let x = 12; x < 28; x++) water.push([x, y]);
    const game = start(duel(40, 15, water), [9, 7], [30, 7]);
    game.player(1).gold = 20000;
    game.queue({ type: 'build', player: 1, tile: 7 * 40 + 11, kind: 'port' });
    game.step();
    return game;
  }

  it('sail from a port to where they are sent and shell enemy coast in range', () => {
    const game = sea();
    expect(game.canWarship(game.player(1))).toBeNull();
    game.queue({ type: 'warship', player: 1, tile: 7 * 40 + 25 });
    game.step();
    expect(game.warships).toHaveLength(1);
    expect(game.player(1).gold).toBeLessThan(20000 - 3000);
    run(game, 40);
    const ship = game.warships[0];
    expect(Math.abs((ship.tile % 40) - 25)).toBeLessThanOrEqual(CONFIG.warship.patrol);
    // B's land grows only by expanding; give it none, so any loss is the guns.
    const before = game.player(2).tiles;
    const events = run(game, 200);
    expect(events.some((e) => e.type === 'shelled' && e.owner === 2)).toBe(true);
    expect(game.player(2).tiles).toBeLessThan(before);
  });

  it('sink enemy boats in range', () => {
    const game = sea();
    game.queue({ type: 'warship', player: 1, tile: 7 * 40 + 14 });
    run(game, 20);
    const b = game.player(2);
    b.gold = 20000;
    b.troops = 5000;
    game.queue({ type: 'build', player: 2, tile: 7 * 40 + 28, kind: 'port' });
    game.step();
    game.queue({ type: 'boat', player: 2, tile: 7 * 40 + 11, permille: 500 });
    game.step();
    expect(game.boats).toHaveLength(1);
    const events = run(game, 40);
    expect(events).toContainEqual(expect.objectContaining({ type: 'sunk', owner: 2, by: 1 }));
    expect(game.boats).toHaveLength(0);
  });
});

describe('fog of war', () => {
  it('limits what a player (and so a bot) can see to near their own land', () => {
    const fogged = start({ ...duel(90, 7), fog: true }, [3, 3], [86, 3]);
    const clear = start(duel(90, 7), [3, 3], [86, 3]);
    const far = fogged.player(2).capital;
    expect(fogged.canSee(fogged.player(1), far)).toBe(false);
    expect(clear.canSee(clear.player(1), far)).toBe(true);
    // Their own land is always in sight, and so is anything near the border.
    expect(fogged.canSee(fogged.player(1), fogged.player(1).capital)).toBe(true);
    expect(fogged.canSee(fogged.player(1), 3 * 90 + 3 + CONFIG.fogSight)).toBe(true);
  });
});

describe('real maps', () => {
  it('decode to the full mask size', () => {
    for (const mask of Object.values(REAL_MASKS)) {
      const land = decodeMask(mask);
      expect(land.length).toBe(mask.width * mask.height);
      const share = land.reduce((n, v) => n + v, 0) / land.length;
      expect(share).toBeGreaterThan(0.2);
      expect(share).toBeLessThan(0.7);
    }
  });

  it('build a world with mountains and several continents to start on', () => {
    const map = buildRealMap('world', 552 * 345, 1);
    const counts = [0, 0, 0, 0];
    for (const v of map.terrain) counts[v]++;
    expect(counts[Terrain.Mountains]).toBeGreaterThan(0);
    // Start land on both sides of the Atlantic: the Americas and Afro-Eurasia.
    const x = (lon: number) => Math.floor(((lon + 180) / 360) * map.width);
    let west = 0;
    let east = 0;
    for (let t = 0; t < map.terrain.length; t++) {
      if (!map.mainland[t]) continue;
      if (t % map.width < x(-30)) west++;
      else east++;
    }
    expect(west).toBeGreaterThan(map.landTiles * 0.15);
    expect(east).toBeGreaterThan(map.landTiles * 0.4);
  });
});

describe('total conquest', () => {
  it('keeps going past 70% of the land and ends when the last enemy is gone', () => {
    const settings = { ...duel(40, 5), conquest: true };
    const game = start(settings, [5, 2], [35, 2]);
    const a = game.player(1);
    // Most of the map, but B still stands: not over.
    a.troops = 1e6;
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    run(game, 300);
    expect(a.tiles).toBeGreaterThan(game.map.landTiles * CONFIG.winShare);
    expect(game.phase).toBe('play');
    a.troops = 1e7;
    game.queue({ type: 'attack', player: 1, target: 2, permille: 1000 });
    const events = run(game, 2000);
    expect(game.phase).toBe('over');
    expect(game.winner).toBe(1);
    expect(events).toContainEqual({ type: 'gameOver', winner: 1 });
  });

  it('ends alliances once only two sides are left', () => {
    const settings = { ...duel(40, 5), conquest: true };
    settings.players[1].bot = true;
    const game = new Game(settings);
    game.queue({ type: 'spawn', player: 1, tile: 2 * 40 + 5 });
    game.step();
    game.queue({ type: 'ally', player: 1, target: 2 });
    run(game, 3);
    expect(game.allied(1, 2)).toBe(false);
  });
});

describe('teams', () => {
  it('deals players into teams that are allied for good and can share troops and gold', () => {
    const options: MatchOptions = { ...botMatch, bots: 7, teams: 2 };
    const game = new Game(createSettings(options, createMap(options)));
    expect(game.players.map((p) => p.team)).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
    expect(game.teammates(1, 3)).toBe(true);
    expect(game.allied(1, 3)).toBe(true);
    expect(game.allied(1, 2)).toBe(false);
    // An alliance can't be broken between teammates.
    game.queue({ type: 'breakAlly', player: 1, target: 3 });
    game.step();
    expect(game.allied(1, 3)).toBe(true);
  });

  it('moves troops and gold to a teammate, never to an opponent', () => {
    const settings = duel(30, 5);
    settings.players.push({ name: 'C', color: 0x00ff00, bot: false });
    settings.players[0].team = 1;
    settings.players[1].team = 2;
    settings.players[2].team = 1;
    const game = new Game(settings);
    game.queue({ type: 'spawn', player: 1, tile: 2 * 30 + 3 });
    game.queue({ type: 'spawn', player: 2, tile: 2 * 30 + 15 });
    game.queue({ type: 'spawn', player: 3, tile: 2 * 30 + 26 });
    game.step();
    const [a, b, c] = game.players;
    a.gold = 900;
    const troops = a.troops;
    const before = c.troops;
    game.queue({ type: 'donate', player: 1, target: 3, troops: 500, gold: 300 });
    game.queue({ type: 'donate', player: 1, target: 2, troops: 500, gold: 300 });
    const events = run(game, 1);
    expect(events.filter((e) => e.type === 'donated')).toHaveLength(1);
    expect(c.troops).toBeGreaterThan(before + troops * 0.4);
    expect(c.gold).toBeGreaterThanOrEqual(300);
    expect(b.gold).toBeLessThan(300);
  });
});

describe('battle royale', () => {
  it('floods the land from the outside in, warning first, and keeps the map consistent', () => {
    const options: MatchOptions = { ...botMatch, mode: 'royale', mapSize: 'small', human: null };
    const map = createMap(options);
    const landBefore = map.landTiles;
    const game = new Game(createSettings(options, map));
    run(game, CONFIG.royale.grace - CONFIG.royale.warning + 50);
    // Warned, not yet flooded.
    expect(game.doomed.some((d) => d === 1)).toBe(true);
    expect(game.map.landTiles).toBe(landBefore);
    run(game, 1500);
    expect(game.map.landTiles).toBeLessThan(landBefore);
    // The shared map is untouched; only this game's copy floods.
    expect(map.landTiles).toBe(landBefore);
    let land = 0;
    for (let t = 0; t < game.size; t++) {
      if (game.map.terrain[t] !== Terrain.Water) land++;
      else expect(game.owner[t]).toBe(NEUTRAL);
    }
    expect(land).toBe(game.map.landTiles);
    expect(game.players.reduce((n, p) => n + p.tiles, 0)).toBeLessThanOrEqual(land);
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

describe('beachheads', () => {
  it('hold after landing on an enemy coast instead of being swallowed as an enclave', () => {
    // A strait at x = 20..23; B lives on the far side.
    const strait = Array.from({ length: 12 * 4 }, (_, i): [number, number] => [20 + (i % 4), Math.floor(i / 4)]);
    const game = start(duel(40, 12, strait), [4, 5], [32, 5]);
    const a = game.player(1);
    const b = game.player(2);
    game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
    game.queue({ type: 'attack', player: 2, target: NEUTRAL, permille: 1000 });
    run(game, 200);
    a.gold = 1e6;
    game.queue({ type: 'build', player: 1, tile: 5 * 40 + 19, kind: 'port' });
    game.step();
    a.troops = 3 * b.troops;
    const target = 5 * 40 + 28;
    expect(game.owner[target]).toBe(2);
    game.queue({ type: 'boat', player: 1, tile: target, permille: 1000 });
    const events = run(game, 120);
    expect(events.some((e) => e.type === 'landed')).toBe(true);
    let held = 0;
    for (let t = 0; t < game.size; t++) if (t % 40 > 23 && game.owner[t] === 1) held++;
    expect(held).toBeGreaterThan(10);
  });
});

describe('pressure', () => {
  it('moves a much bigger army faster through enemy land', () => {
    const takenIn = (times: number) => {
      const game = start(duel(60, 7), [10, 3], [50, 3]);
      game.queue({ type: 'attack', player: 1, target: NEUTRAL, permille: 1000 });
      game.queue({ type: 'attack', player: 2, target: NEUTRAL, permille: 1000 });
      run(game, 120);
      const a = game.player(1);
      a.troops = times * game.player(2).troops;
      const before = a.tiles;
      game.queue({ type: 'attack', player: 1, target: 2, permille: 1000 });
      run(game, 12);
      return a.tiles - before;
    };
    const fast = takenIn(30);
    const slow = takenIn(2);
    expect(fast).toBeGreaterThan(slow);
  });
});
