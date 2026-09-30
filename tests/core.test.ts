import { describe, expect, it } from 'vitest';
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
