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
  /** Builds cities, and defence posts when attacked. */
  builds: boolean;
  /** Attacks much weaker neighbours even before its troops fill up. */
  opportunist: boolean;
  /** 0: never fires, 1: rockets, 2: rockets and nukes. */
  missiles: 0 | 1 | 2;
  /** Chance per decision to fire when a missile is ready. */
  missileChance: number;
}

type Range = readonly [number, number];

interface Profile {
  every: number;
  expandAt: Range;
  expandSend: Range;
  attackAt: Range;
  attackSend: Range;
  aggression: number;
  missiles: 0 | 1 | 2;
  missileChance: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  easy: { every: 25, expandAt: [0.1, 0.2], expandSend: [300, 500], attackAt: [0.85, 0.97], attackSend: [200, 350], aggression: 0.25, missiles: 0, missileChance: 0 },
  normal: { every: 12, expandAt: [0.03, 0.08], expandSend: [500, 750], attackAt: [0.6, 0.85], attackSend: [300, 500], aggression: 0.45, missiles: 1, missileChance: 0.03 },
  hard: { every: 6, expandAt: [0.01, 0.04], expandSend: [700, 900], attackAt: [0.45, 0.7], attackSend: [400, 650], aggression: 0.7, missiles: 2, missileChance: 0.04 },
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
    // Most bots build; on easy, some don't bother.
    builds: difficulty !== 'easy' || rng.next() < 0.5,
    opportunist: difficulty !== 'easy',
    missiles: p.missiles,
    missileChance: p.missileChance,
  };
}

/**
 * One decision round for a bot: maybe spend gold, maybe send troops. Runs
 * inside the simulation, so it may only use the game's own random numbers.
 */
export function botThink(game: Game, p: Player, rng: Rng): Intent[] {
  const brain = p.brain;
  if (!brain) return [];
  const out: Intent[] = [];
  const survey = surveyBorder(game, p);
  const spend = spendGold(game, p, brain, rng, survey.shared);
  if (spend) out.push(spend);
  const move = sendTroops(game, p, brain, rng, survey);
  if (move) out.push(move);
  return out;
}

interface Survey {
  /** Border tiles facing unclaimed land. */
  neutral: number;
  /** Border tiles facing each (non-allied) neighbour. */
  shared: Map<number, number>;
}

function surveyBorder(game: Game, p: Player): Survey {
  const { owner, width, size } = game;
  const terrain = game.map.terrain;
  let neutral = 0;
  const shared = new Map<number, number>();
  const look = (n: number) => {
    if (terrain[n] === Terrain.Water) return;
    const o = owner[n];
    if (o === p.id || game.allied(p.id, o)) return;
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
  return { neutral, shared };
}

/** Cities as land grows, a defence post when attacked, then a silo and missiles at the leader. */
function spendGold(game: Game, p: Player, brain: BotBrain, rng: Rng, neighbours: Map<number, number>): Intent | null {
  if (brain.builds) {
    if (p.owned.city < 1 + Math.floor(p.tiles / 1200) && p.gold >= game.buildCost(p, 'city')) {
      const tile = game.findSpot(p, 'city');
      if (tile >= 0) return { type: 'build', player: p.id, tile, kind: 'city' };
    }
    // A factory once there are cities for its trains to visit.
    if (p.owned.city >= 2 && p.owned.factory < Math.ceil(p.owned.city / 4) && p.gold >= game.buildCost(p, 'factory')) {
      const tile = game.findSpot(p, 'factory');
      if (tile >= 0) return { type: 'build', player: p.id, tile, kind: 'factory' };
    }
    if (p.owned.port === 0 && p.tiles > 800 && p.gold >= game.buildCost(p, 'port')) {
      const tile = game.findSpot(p, 'port');
      if (tile >= 0) return { type: 'build', player: p.id, tile, kind: 'port' };
    }
    const underAttack = game.attacks.some((a) => a.target === p.id);
    if (underAttack && p.owned.defense < 1 + Math.floor(p.tiles / 2500) && p.gold >= game.buildCost(p, 'defense')) {
      const tile = game.findSpot(p, 'defense', true);
      if (tile >= 0) return { type: 'build', player: p.id, tile, kind: 'defense' };
    }
  }
  if (brain.missiles === 0 || p.tiles < 1500) return null;
  if (p.owned.silo === 0) {
    if (p.gold < game.buildCost(p, 'silo')) return null;
    const tile = game.findSpot(p, 'silo');
    return tile >= 0 ? { type: 'build', player: p.id, tile, kind: 'silo' } : null;
  }
  // Keep a reserve, so gold also goes to cities and defence.
  if (p.gold < 2 * game.missileCost('rocket') || rng.next() > brain.missileChance) return null;
  // Nukes go for the biggest rival's capital: it costs them half their troops.
  if (brain.missiles === 2 && game.canLaunch(p, 'nuke') === null) {
    let rival: Player | null = null;
    for (const q of game.players) {
      if (q.alive && q.id !== p.id && !game.allied(p.id, q.id) && (!rival || q.tiles > rival.tiles)) rival = q;
    }
    if (rival && rival.capital >= 0) return { type: 'launch', player: p.id, tile: rival.capital, kind: 'nuke' };
  }
  // Rockets clear the way: an enemy defence post or city owned by a neighbour.
  if (game.canLaunch(p, 'rocket') !== null) return null;
  let target = -1;
  for (const b of game.buildings) {
    if (b.kind === 'silo' || !neighbours.has(b.owner)) continue;
    target = b.tile;
    if (b.kind === 'defense') break;
  }
  return target >= 0 ? { type: 'launch', player: p.id, tile: target, kind: 'rocket' } : null;
}

/** Grab neutral land while there is any, then pick on the neighbour that is cheapest to attack. */
function sendTroops(game: Game, p: Player, brain: BotBrain, rng: Rng, survey: Survey): Intent | null {
  const max = game.maxTroops(p);
  if (max <= 0) return null;
  const fill = p.troops / max;

  // With a port, now and then ship troops to an unclaimed island.
  if (p.owned.port > 0 && p.troops > 800 && rng.next() < 0.25) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const t = rng.int(game.size);
      if (game.map.terrain[t] === Terrain.Water || game.map.mainland[t] || game.owner[t] !== NEUTRAL) continue;
      if (typeof game.planBoat(p, t) !== 'string') return { type: 'boat', player: p.id, tile: t, permille: 350 };
      break;
    }
  }

  const { neutral, shared } = survey;

  if (neutral > 0 && fill >= brain.expandAt) {
    return { type: 'attack', player: p.id, target: NEUTRAL, permille: brain.expandSend };
  }
  if (shared.size === 0) return null;
  // Below the usual threshold, only pick on neighbours with under half our troops.
  const strongerThan = (id: number) => brain.opportunist && game.player(id).troops * 2 < p.troops;
  if (fill < brain.attackAt && ![...shared.keys()].some(strongerThan)) return null;
  // Still room to grow for free: only fight when nearly full.
  if (neutral > 0 && fill < 0.95) return null;
  if (rng.next() > brain.aggression) return null;

  // Cheapest neighbour: thin defences and a long shared border.
  let target = NEUTRAL;
  let bestScore = Infinity;
  for (const [id, edge] of shared) {
    if (fill < brain.attackAt && !strongerThan(id)) continue;
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
