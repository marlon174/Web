/**
 * Plays a bots-only match headlessly and prints how the land is split over
 * time. Handy after changing numbers in src/core/config.ts:
 *   npm run sim -- [seed] [bots] [difficulty] [small|medium|large]
 */
import type { Difficulty } from '../src/core/bots';
import { CONFIG } from '../src/core/config';
import { Game } from '../src/core/game';
import type { MapSize } from '../src/core/map';
import { createMap, createSettings, type MatchOptions } from '../src/core/setup';

const [seedArg, botsArg, difficultyArg, sizeArg] = process.argv.slice(2);
const options: MatchOptions = {
  seed: Number(seedArg ?? 1),
  mode: 'classic',
  mapSize: (sizeArg ?? 'medium') as MapSize,
  bots: Number(botsArg ?? 12),
  difficulty: (difficultyArg ?? 'normal') as Difficulty,
  human: null,
};

let started = performance.now();
const map = createMap(options);
console.log(`map ${map.width}x${map.height}, ${map.landTiles} land tiles, generated in ${(performance.now() - started).toFixed(0)} ms`);

const game = new Game(createSettings(options, map));
const perSecond = CONFIG.ticksPerSecond;
started = performance.now();
let slowest = 0;
while (game.phase !== 'over' && game.tick < 20 * 60 * perSecond) {
  const t = performance.now();
  game.step();
  slowest = Math.max(slowest, performance.now() - t);
  if (game.tick % (30 * perSecond) === 0) {
    const alive = game.players.filter((p) => p.alive).sort((a, b) => b.tiles - a.tiles);
    const top = alive
      .slice(0, 4)
      .map((p) => `${p.name} ${((100 * p.tiles) / map.landTiles).toFixed(1)}%`)
      .join(', ');
    const neutral = map.landTiles - alive.reduce((sum, p) => sum + p.tiles, 0);
    console.log(
      `${String(game.tick / perSecond).padStart(5)}s  alive ${String(alive.length).padStart(2)}  neutral ${((100 * neutral) / map.landTiles).toFixed(1).padStart(5)}%  ${top}`,
    );
  }
}
const elapsed = performance.now() - started;
const winner = game.winner ? game.player(game.winner).name : 'nobody';
console.log(`winner ${winner} after ${(game.tick / perSecond).toFixed(0)}s of game time`);
console.log(`simulated ${game.tick} ticks in ${elapsed.toFixed(0)} ms (avg ${(elapsed / game.tick).toFixed(2)} ms, slowest ${slowest.toFixed(1)} ms)`);
