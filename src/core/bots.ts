import { CONFIG } from './config';
import { NEUTRAL, type Game, type Intent, type Player } from './game';
import { Terrain } from './map';
import type { Rng } from './rng';

export type Difficulty = 'easy' | 'normal' | 'hard';

/** A bot's personality, rolled once when the match starts. */
export interface BotBrain {
  /** Ticks between decisions. */
  every: number;
  offset: number;
  /** Fill level (troops ÷ cap) before expanding into neutral land, and how much to send (‰). */
  expandAt: number;
  expandSend: number;
  /** Fill level before attacking a neighbour, and how much to send (‰). */
  attackAt: number;
  attackSend: number;
  /** Chance to attack when an attack is possible. */
  aggression: number;
}

type Range = readonly [number, number];

const PROFILES: Record<
  Difficulty,
  { every: number; expandAt: Range; expandSend: Range; attackAt: Range; attackSend: Range; aggression: number }
> = {
  easy: { every: 25, expandAt: [0.1, 0.2], expandSend: [300, 500], attackAt: [0.85, 0.97], attackSend: [200, 350], aggression: 0.25 },
  normal: { every: 12, expandAt: [0.03, 0.08], expandSend: [500, 750], attackAt: [0.6, 0.85], attackSend: [300, 500], aggression: 0.45 },
  hard: { every: 6, expandAt: [0.01, 0.04], expandSend: [700, 900], attackAt: [0.45, 0.7], attackSend: [400, 650], aggression: 0.7 },
};

export function createBrain(rng: Rng, difficulty: Difficulty, index: number): BotBrain {
  const p = PROFILES[difficulty];
  return {
    every: p.every,
    offset: index % p.every,
    expandAt: rng.range(p.expandAt[0], p.expandAt[1]),
    expandSend: Math.round(rng.range(p.expandSend[0], p.expandSend[1])),
    attackAt: rng.range(p.attackAt[0], p.attackAt[1]),
    attackSend: Math.round(rng.range(p.attackSend[0], p.attackSend[1])),
    aggression: p.aggression,
  };
}

/**
 * Simple rules: grab neutral land while there is any, then pick on the
 * neighbour that is cheapest to attack. Runs inside the simulation, so it may
 * only use the game's own random numbers.
 */
export function botThink(game: Game, p: Player, rng: Rng): Intent | null {
  const brain = p.brain;
  const max = game.maxTroops(p);
  if (!brain || max <= 0) return null;
  const fill = p.troops / max;

  // Survey the border: how much neutral land, and which neighbours.
  const { owner, width, size } = game;
  const terrain = game.map.terrain;
  let neutral = 0;
  const shared = new Map<number, number>();
  const look = (n: number) => {
    if (terrain[n] === Terrain.Water) return;
    const o = owner[n];
    if (o === p.id) return;
    if (o === NEUTRAL) neutral++;
    else shared.set(o, (shared.get(o) ?? 0) + 1);
  };
  for (const t of p.border) {
    const x = t % width;
    if (x > 0) look(t - 1);
    if (x < width - 1) look(t + 1);
    if (t >= width) look(t - width);
    if (t + width < size) look(t + width);
  }

  if (neutral > 0 && fill >= brain.expandAt) {
    return { type: 'attack', player: p.id, target: NEUTRAL, permille: brain.expandSend };
  }
  if (shared.size === 0 || fill < brain.attackAt) return null;
  // Still room to grow for free: only fight when nearly full.
  if (neutral > 0 && fill < 0.95) return null;
  if (rng.next() > brain.aggression) return null;

  // Cheapest neighbour: thin defences and a long shared border.
  let target = NEUTRAL;
  let bestScore = Infinity;
  for (const [id, edge] of shared) {
    const e = game.player(id);
    const density = e.troops / e.tiles;
    const score = (density * rng.range(0.75, 1.25)) / Math.sqrt(edge);
    if (score < bestScore) {
      bestScore = score;
      target = id;
    }
  }
  const e = game.player(target);
  const perTile = CONFIG.neutralCost + (CONFIG.defenseFactor * e.troops) / e.tiles;
  const send = (p.troops * brain.attackSend) / 1000;
  // Not worth it if the attack would stall after a handful of tiles.
  if (send / perTile < 8) return null;
  return { type: 'attack', player: p.id, target, permille: brain.attackSend };
}
