import { botThink, createBrain, type BotBrain, type Difficulty } from './bots';
import { CONFIG } from './config';
import { TileHeap } from './heap';
import { fbm, Terrain, type GameMap } from './map';
import { Rng } from './rng';

/** Owner id of land nobody holds. Players are numbered from 1. */
export const NEUTRAL = 0;

/** Attack fronts schedule tiles in tenths of a tick. */
const SUBTICKS = 10;

export interface PlayerSetup {
  name: string;
  /** 0xRRGGBB */
  color: number;
  bot: boolean;
}

export interface GameSettings {
  seed: number;
  map: GameMap;
  players: PlayerSetup[];
  difficulty: Difficulty;
  /** Match length in ticks. 0 plays until someone holds `CONFIG.winShare` of the land. */
  timeLimit: number;
  /** Battle royale: the sea rises and swallows the map from the outside in. */
  royale?: boolean;
}

export interface Player {
  readonly id: number;
  readonly name: string;
  readonly color: number;
  readonly bot: boolean;
  alive: boolean;
  spawned: boolean;
  troops: number;
  tiles: number;
  /** Tile index of the capital, or -1. */
  capital: number;
  /** Owned tiles next to land held by someone else, in no particular order. */
  readonly border: number[];
  /** Sums of owned tile coordinates, for the centre of the territory. */
  sumX: number;
  sumY: number;
  peakTiles: number;
  /** Final placing (1 = winner). 0 until the player is out or the match ends. */
  place: number;
  gold: number;
  /** How many of each building the player owns right now. */
  readonly owned: Record<BuildingKind, number>;
  readonly brain: BotBrain | null;
}

export type BuildingKind = 'city' | 'defense' | 'silo' | 'port' | 'factory';
export type MissileKind = 'rocket' | 'nuke' | 'hbomb';
export const BUILDING_KINDS: readonly BuildingKind[] = ['city', 'defense', 'silo', 'port', 'factory'];

export interface Building {
  readonly id: number;
  readonly kind: BuildingKind;
  readonly tile: number;
  owner: number;
  /** Tick a train last paid out here (cities and ports). */
  paidAt?: number;
  /** Tick a silo can fire again. */
  readyAt?: number;
}

export interface Missile {
  readonly id: number;
  readonly kind: MissileKind;
  readonly owner: number;
  /** Silo it left from, and the tile it will hit. */
  readonly from: number;
  readonly to: number;
  /** Who held the target tile at launch (NEUTRAL for empty land). */
  readonly victim: number;
  readonly launched: number;
  readonly arrives: number;
}

/** Why a build or launch isn't possible right now. */
export type Refusal =
  | 'notYours'
  | 'tooClose'
  | 'gold'
  | 'noSilo'
  | 'offMap'
  | 'notCoast'
  | 'noPort'
  | 'noRoute'
  | 'boats'
  | 'ally'
  | 'limit'
  | 'reloading'
  | 'silos';

/** A train running from a factory through your cities and ports, and back. */
export interface Train {
  readonly id: number;
  readonly owner: number;
  /** Factory, the stops in order, then the factory again. */
  readonly route: number[];
  /** Index of the stop it is heading for, and tiles covered on this leg. */
  leg: number;
  progress: number;
}

/** Troops at sea, heading for a beach. */
export interface Boat {
  readonly id: number;
  readonly owner: number;
  troops: number;
  /** Water tiles from the port to the beach, then the beach tile itself. */
  readonly path: number[];
  /** Position along the path, in tiles. */
  pos: number;
}

/** A warship: sinks enemy boats and ships in range, and shells enemy coast. */
export interface Warship {
  readonly id: number;
  readonly owner: number;
  /** Water tile it is on. */
  tile: number;
  hp: number;
  /** Water tiles still to sail, next first. */
  route: number[];
  /** Where it was sent: it patrols around here once it arrives. */
  station: number;
}

export type Intent =
  | { type: 'spawn'; player: number; tile: number }
  | { type: 'attack'; player: number; target: number; permille: number }
  | { type: 'build'; player: number; tile: number; kind: BuildingKind }
  | { type: 'launch'; player: number; tile: number; kind: MissileKind }
  | { type: 'boat'; player: number; tile: number; permille: number }
  | { type: 'ally'; player: number; target: number }
  | { type: 'breakAlly'; player: number; target: number }
  | { type: 'recall'; player: number; target: number }
  | { type: 'warship'; player: number; tile: number };

export type GameEvent =
  | { type: 'capitalLost'; player: number; by: number }
  | { type: 'eliminated'; player: number; by: number }
  | { type: 'encircled'; player: number; by: number; tiles: number }
  | { type: 'captured'; kind: BuildingKind; tile: number; from: number; by: number }
  | { type: 'bunkerDestroyed'; tile: number; from: number; by: number }
  | { type: 'launched'; missile: Missile }
  | { type: 'impact'; missile: Missile; losses: { player: number; tiles: number }[]; buildings: number }
  | { type: 'trainStop'; owner: number; tile: number; gold: number }
  | { type: 'landed'; owner: number; tile: number; target: number }
  | { type: 'repelled'; owner: number; tile: number; target: number }
  | { type: 'alliance'; from: number; to: number; accepted: boolean }
  | { type: 'allianceOffer'; from: number; to: number }
  | { type: 'allianceEnded'; a: number; b: number; brokenBy: number }
  | { type: 'sunk'; owner: number; by: number; troops: number }
  | { type: 'shipSunk'; owner: number; by: number; tile: number }
  | { type: 'shelled'; tile: number; owner: number; by: number }
  | { type: 'flooded'; tiles: number[] }
  | { type: 'gameOver'; winner: number };

export interface Attack {
  readonly attacker: number;
  readonly target: number;
  /** Troops still in the field. Returned to the attacker when the attack ends. */
  troops: number;
  /** Target tiles touching the front, keyed by the tick they can fall. */
  readonly frontier: TileHeap;
  done: boolean;
}

export type Phase = 'spawn' | 'play' | 'over';

/**
 * The whole simulation. It is deterministic: the same settings and the same
 * intents on the same ticks always produce the same game, which is what
 * lockstep multiplayer and replays rely on. Keep it that way by using only
 * `this.rng` for randomness, basic arithmetic (no Math.sin/exp/pow), and no
 * clocks or DOM.
 */
export class Game {
  readonly settings: GameSettings;
  readonly map: GameMap;
  readonly width: number;
  readonly height: number;
  readonly size: number;
  /** Owner id per tile. Water is always NEUTRAL. */
  readonly owner: Uint16Array;
  /** Tick until which each tile is contaminated by a missile, 0 if never hit. */
  readonly fallout: Int32Array;
  /** Players by id - 1. Use `player(id)`. */
  readonly players: Player[];
  tick = 0;
  phase: Phase = 'spawn';
  winner = NEUTRAL;
  /** Every intent applied so far with the tick it ran on: enough to replay the match. */
  readonly log: { tick: number; intent: Intent }[] = [];

  private readonly rng: Rng;
  private readonly terrain: Uint8Array;
  /** Battle royale: land tiles in the order the sea takes them, and how many it has. */
  private readonly floodOrder: Int32Array | null = null;
  private floodedCount = 0;
  private doomedCount = 0;
  /** 1 for land the sea will take within the warning time (battle royale). */
  readonly doomed: Uint8Array;
  /** Position of each tile in its owner's border list, or -1. */
  private readonly borderPos: Int32Array;
  private attackList: Attack[] = [];
  private readonly buildingsByTile = new Map<number, Building>();
  /** Defence post tiles per owner, so coverage checks only look at that player's posts. */
  private readonly posts = new Map<number, number[]>();
  private readonly sweepInterval: number;
  // Scratch space for boat routes.
  private readonly waterParent: Int32Array;
  private readonly waterSeen: Int32Array;
  private readonly waterQueue: Int32Array;
  private waterStamp = 0;
  private missileList: Missile[] = [];
  private nextId = 1;
  private trainList: Train[] = [];
  private boatList: Boat[] = [];
  private shipList: Warship[] = [];
  /** Alliance expiry tick, and cool-down end tick, keyed by "low:high" player ids. */
  private readonly alliances = new Map<string, number>();
  private readonly cooldowns = new Map<string, number>();
  /** Alliance offers to humans waiting for an answer, "from:to", with the tick they lapse. */
  private readonly offers = new Map<string, number>();
  private pending: Intent[] = [];
  private changed: number[] = [];
  private events: GameEvent[] = [];
  // Scratch space for the encirclement sweep.
  private readonly seen: Int32Array;
  private readonly stack: Int32Array;
  private readonly component: Int32Array;
  private sweepStamp = 0;

  constructor(settings: GameSettings) {
    this.settings = settings;
    // The sea changes the land in battle royale, so that game gets its own copy of the map.
    this.map = settings.royale ? { ...settings.map, terrain: settings.map.terrain.slice() } : settings.map;
    this.width = this.map.width;
    this.height = this.map.height;
    this.size = this.width * this.height;
    this.terrain = this.map.terrain;
    this.doomed = new Uint8Array(settings.royale ? this.size : 0);
    if (settings.royale) this.floodOrder = this.planFlood(settings.seed);
    this.owner = new Uint16Array(this.size);
    this.fallout = new Int32Array(this.size);
    this.borderPos = new Int32Array(this.size).fill(-1);
    this.seen = new Int32Array(this.size);
    this.stack = new Int32Array(this.size);
    this.component = new Int32Array(this.size);
    this.waterParent = new Int32Array(this.size);
    this.waterSeen = new Int32Array(this.size);
    this.waterQueue = new Int32Array(this.size);
    // The encirclement sweep scans the whole map, so big maps run it less often.
    this.sweepInterval = Math.max(CONFIG.sweepEvery, Math.round((CONFIG.sweepEvery * this.size) / 200000));
    this.rng = new Rng(settings.seed);
    this.players = settings.players.map((setup, i) => ({
      id: i + 1,
      name: setup.name,
      color: setup.color,
      bot: setup.bot,
      alive: true,
      spawned: false,
      troops: 0,
      tiles: 0,
      capital: -1,
      border: [],
      sumX: 0,
      sumY: 0,
      peakTiles: 0,
      place: 0,
      gold: 0,
      owned: { city: 0, defense: 0, silo: 0, port: 0, factory: 0 },
      brain: setup.bot ? createBrain(this.rng, settings.difficulty, i) : null,
    }));
  }

  player(id: number): Player {
    return this.players[id - 1];
  }

  isPlayerId(id: number): boolean {
    return Number.isInteger(id) && id >= 1 && id <= this.players.length;
  }

  get attacks(): readonly Attack[] {
    return this.attackList;
  }

  /** Buildings in the order they were built. */
  get buildings(): IterableIterator<Building> {
    return this.buildingsByTile.values();
  }

  buildingAt(tile: number): Building | undefined {
    return this.buildingsByTile.get(tile);
  }

  get missiles(): readonly Missile[] {
    return this.missileList;
  }

  maxTroops(p: Player): number {
    const bonus = Math.min(CONFIG.cityCapMax, CONFIG.cityCapBonus * p.owned.city);
    return p.tiles * CONFIG.troopsPerTile * (1 + bonus);
  }

  /** How many buildings of this kind `p` may own before needing more land. */
  buildLimit(p: Player, kind: BuildingKind): number {
    return 2 + Math.floor(p.tiles / CONFIG.tilesPerBuilding[kind]);
  }

  /** Gold price of the next building of this kind for `p`. */
  buildCost(p: Player, kind: BuildingKind): number {
    const { cost, step, max } = CONFIG.buildings[kind];
    return Math.min(max, cost + step * p.owned[kind]);
  }

  get trains(): readonly Train[] {
    return this.trainList;
  }

  get boats(): readonly Boat[] {
    return this.boatList;
  }

  get warships(): readonly Warship[] {
    return this.shipList;
  }

  /** How many warships `p` may have afloat. */
  warshipLimit(p: Player): number {
    return Math.min(CONFIG.warship.max, p.owned.port * CONFIG.warship.perPort);
  }

  /** Null if `p` can launch another warship now, else why not. */
  canWarship(p: Player): Refusal | null {
    if (!p.alive) return 'notYours';
    if (p.owned.port === 0) return 'noPort';
    if (this.shipList.filter((s) => s.owner === p.id).length >= this.warshipLimit(p)) return 'limit';
    if (p.gold < CONFIG.warship.cost) return 'gold';
    return null;
  }

  isWater(tile: number): boolean {
    return tile >= 0 && tile < this.size && this.terrain[tile] === Terrain.Water;
  }

  /**
   * Breadth-first search over water from `start` until `goal` accepts a tile.
   * Returns the tiles from start to that tile, or null. `limit` caps the
   * tiles explored, to keep short hops cheap.
   */
  private waterRoute(start: number, goal: (tile: number) => boolean, limit = Infinity): number[] | null {
    if (!this.isWater(start)) return null;
    const { width: w, size, terrain, waterParent: parent, waterSeen: seenAt, waterQueue: queue } = this;
    const stamp = ++this.waterStamp;
    seenAt[start] = stamp;
    parent[start] = -1;
    queue[0] = start;
    let tail = 1;
    for (let head = 0; head < tail && head < limit; head++) {
      const t = queue[head];
      if (goal(t)) {
        const path: number[] = [];
        for (let c = t; c !== -1; c = parent[c]) path.push(c);
        return path.reverse();
      }
      const x = t % w;
      for (let k = 0; k < 4; k++) {
        const n = k === 0 ? (x > 0 ? t - 1 : -1) : k === 1 ? (x < w - 1 ? t + 1 : -1) : k === 2 ? t - w : t + w;
        if (n < 0 || n >= size || terrain[n] !== Terrain.Water || seenAt[n] === stamp) continue;
        seenAt[n] = stamp;
        parent[n] = t;
        queue[tail++] = n;
      }
    }
    return null;
  }

  /** Whether a water tile touches one of `owner`'s ports. */
  private besidePort(tile: number, owner: number): boolean {
    const w = this.width;
    const x = tile % w;
    for (const n of [x > 0 ? tile - 1 : -1, x < w - 1 ? tile + 1 : -1, tile - w, tile + w]) {
      if (n < 0 || n >= this.size) continue;
      const b = this.buildingsByTile.get(n);
      if (b && b.kind === 'port' && b.owner === owner) return true;
    }
    return false;
  }

  /** A water tile next to one of `p`'s ports, or -1: where bots station their ships. */
  portWater(p: Player): number {
    const w = this.width;
    for (const b of this.buildingsByTile.values()) {
      if (b.kind !== 'port' || b.owner !== p.id) continue;
      const x = b.tile % w;
      for (const n of [x > 0 ? b.tile - 1 : -1, x < w - 1 ? b.tile + 1 : -1, b.tile - w, b.tile + w]) {
        if (this.isWater(n)) return n;
      }
    }
    return -1;
  }

  isCoast(tile: number): boolean {
    if (!this.isLand(tile)) return false;
    const { width, size, terrain } = this;
    const x = tile % width;
    return (
      (x > 0 && terrain[tile - 1] === Terrain.Water) ||
      (x < width - 1 && terrain[tile + 1] === Terrain.Water) ||
      (tile >= width && terrain[tile - width] === Terrain.Water) ||
      (tile + width < size && terrain[tile + width] === Terrain.Water)
    );
  }

  // Alliances

  private pairKey(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  allied(a: number, b: number): boolean {
    return a !== b && a !== NEUTRAL && b !== NEUTRAL && this.alliances.has(this.pairKey(a, b));
  }

  /** Tick an alliance ends, or 0 if the two aren't allied. */
  allianceEnds(a: number, b: number): number {
    return this.alliances.get(this.pairKey(a, b)) ?? 0;
  }

  /**
   * The cities and ports a factory's rail reaches, in the order its train
   * visits them: nearest first, then always on to the nearest unvisited one.
   */
  railRoute(factory: Building): number[] {
    const w = this.width;
    const fx = factory.tile % w;
    const fy = (factory.tile - fx) / w;
    const dist2 = (a: number, bx: number, by: number) => {
      const ax = a % w;
      const ay = (a - ax) / w;
      return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
    };
    const range = CONFIG.railRange * CONFIG.railRange;
    const near: number[] = [];
    for (const b of this.buildingsByTile.values()) {
      if (b.owner !== factory.owner || (b.kind !== 'city' && b.kind !== 'port')) continue;
      if (dist2(b.tile, fx, fy) <= range) near.push(b.tile);
    }
    near.sort((a, b) => dist2(a, fx, fy) - dist2(b, fx, fy) || a - b);
    const pool = near.slice(0, CONFIG.railStops);
    const route: number[] = [];
    let cx = fx;
    let cy = fy;
    while (pool.length) {
      let best = 0;
      for (let i = 1; i < pool.length; i++) if (dist2(pool[i], cx, cy) < dist2(pool[best], cx, cy)) best = i;
      const next = pool.splice(best, 1)[0];
      route.push(next);
      cx = next % w;
      cy = (next - cx) / w;
    }
    return route;
  }

  /**
   * Where a boat sent at `tile` would land and the water route there from one
   * of `p`'s ports, or the reason it can't go. Pure: safe for the client.
   */
  planBoat(p: Player, tile: number): { path: number[]; target: number } | Refusal {
    if (p.owned.port === 0) return 'noPort';
    if (!this.isLand(tile)) return 'offMap';
    if (this.boatList.filter((b) => b.owner === p.id).length >= CONFIG.maxBoats) return 'boats';
    const { width: w, size, terrain, owner } = this;
    // The beach: the clicked tile if it's on the coast, else the nearest coast within reach.
    let beach = -1;
    if (this.isCoast(tile) && owner[tile] !== p.id) beach = tile;
    else {
      const seen = new Map<number, number>([[tile, 0]]);
      const queue = [tile];
      for (let head = 0; head < queue.length && beach < 0; head++) {
        const t = queue[head];
        const d = seen.get(t)!;
        if (d >= CONFIG.landingSearch) continue;
        const x = t % w;
        for (const n of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, t - w, t + w]) {
          if (n < 0 || n >= size || seen.has(n) || terrain[n] === Terrain.Water) continue;
          seen.set(n, d + 1);
          if (this.isCoast(n) && owner[n] !== p.id) {
            beach = n;
            break;
          }
          queue.push(n);
        }
      }
    }
    if (beach < 0) return 'noRoute';
    if (this.allied(p.id, owner[beach])) return 'ally';

    // Breadth-first search over water, from the beach out to any of p's ports.
    const ports = new Set<number>();
    for (const b of this.buildingsByTile.values()) if (b.kind === 'port' && b.owner === p.id) ports.add(b.tile);
    const { waterParent: parent, waterSeen: seenAt, waterQueue: queue } = this;
    const stamp = ++this.waterStamp;
    let tail = 0;
    const bx = beach % w;
    for (const n of [bx > 0 ? beach - 1 : -1, bx < w - 1 ? beach + 1 : -1, beach - w, beach + w]) {
      if (n >= 0 && n < size && terrain[n] === Terrain.Water && seenAt[n] !== stamp) {
        seenAt[n] = stamp;
        parent[n] = -1;
        queue[tail++] = n;
      }
    }
    for (let head = 0; head < tail; head++) {
      const t = queue[head];
      const x = t % w;
      for (let k = 0; k < 4; k++) {
        const n = k === 0 ? (x > 0 ? t - 1 : -1) : k === 1 ? (x < w - 1 ? t + 1 : -1) : k === 2 ? t - w : t + w;
        if (n < 0 || n >= size) continue;
        if (ports.has(n)) {
          // Found a port: walk back to the beach.
          const path: number[] = [];
          for (let c = t; c !== -1; c = parent[c]) path.push(c);
          path.push(beach);
          return { path, target: beach };
        }
        if (terrain[n] === Terrain.Water && seenAt[n] !== stamp) {
          seenAt[n] = stamp;
          parent[n] = t;
          queue[tail++] = n;
        }
      }
    }
    return 'noRoute';
  }

  missileCost(kind: MissileKind): number {
    return CONFIG.missiles[kind].cost;
  }

  /** Null if `p` can put this building on `tile` now, else the reason not. */
  canBuild(p: Player, kind: BuildingKind, tile: number): Refusal | null {
    if (tile < 0 || tile >= this.size) return 'offMap';
    if (this.owner[tile] !== p.id || !p.alive) return 'notYours';
    if (kind === 'port' && !this.isCoast(tile)) return 'notCoast';
    if (p.owned[kind] >= this.buildLimit(p, kind)) return 'limit';
    const gap = CONFIG.buildingSpacing;
    const x = tile % this.width;
    const y = (tile - x) / this.width;
    for (const b of this.buildingsByTile.values()) {
      const bx = b.tile % this.width;
      const by = (b.tile - bx) / this.width;
      if (Math.abs(bx - x) < gap && Math.abs(by - y) < gap) return 'tooClose';
    }
    if (p.gold < this.buildCost(p, kind)) return 'gold';
    return null;
  }

  /** Null if `p` can fire this missile now, else the reason not. */
  canLaunch(p: Player, kind: MissileKind): Refusal | null {
    if (p.owned.silo === 0 || !p.alive) return 'noSilo';
    if (kind === 'hbomb' && p.owned.silo < CONFIG.hbombSilos) return 'silos';
    if (p.gold < this.missileCost(kind)) return 'gold';
    if (this.readySilos(p) === 0) return 'reloading';
    return null;
  }

  /** How many of `p`'s silos are loaded right now. */
  readySilos(p: Player): number {
    let n = 0;
    for (const b of this.buildingsByTile.values()) {
      if (b.kind === 'silo' && b.owner === p.id && (b.readyAt ?? 0) <= this.tick) n++;
    }
    return n;
  }

  /**
   * A random free spot for a bot's building: inside its land, or on its
   * border when `front` is set. Uses the simulation's random numbers, so only
   * call it from inside the simulation.
   */
  findSpot(p: Player, kind: BuildingKind, front = false): number {
    for (let attempt = 0; attempt < (kind === 'port' ? 400 : 60); attempt++) {
      const t = front ? p.border[this.rng.int(p.border.length)] : this.rng.int(this.size);
      if (t === undefined || (!front && kind !== 'port' && this.borderPos[t] >= 0)) continue;
      if (this.canBuild(p, kind, t) === null) return t;
    }
    return -1;
  }

  isLand(tile: number): boolean {
    return tile >= 0 && tile < this.size && this.terrain[tile] !== Terrain.Water;
  }

  /** Queues an intent to run at the start of the next tick. */
  queue(intent: Intent): void {
    this.pending.push(intent);
  }

  /** Tiles whose owner changed since the last call. */
  drainChanges(): number[] {
    const out = this.changed;
    this.changed = [];
    return out;
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Whether `p` holds land next to land owned by `target` (NEUTRAL for unclaimed land). */
  sharesBorder(p: Player, target: number): boolean {
    const { owner, terrain, width, size } = this;
    for (const t of p.border) {
      const x = t % width;
      if (x > 0 && owner[t - 1] === target && terrain[t - 1] !== Terrain.Water) return true;
      if (x < width - 1 && owner[t + 1] === target && terrain[t + 1] !== Terrain.Water) return true;
      if (t >= width && owner[t - width] === target && terrain[t - width] !== Terrain.Water) return true;
      if (t + width < size && owner[t + width] === target && terrain[t + width] !== Terrain.Water) return true;
    }
    return false;
  }

  /** Advances the game by one tick. */
  step(): void {
    if (this.phase === 'over') return;
    const intents = this.pending;
    this.pending = [];
    for (const intent of intents) this.apply(intent);
    if (this.phase === 'spawn') {
      // Bots take their places once every human has picked a spot.
      if (!this.players.every((p) => p.bot || p.spawned)) return;
      this.spawnBots();
      this.phase = 'play';
    }

    this.runBots();
    this.updateAttacks();
    this.updateMissiles();
    this.updateTrains();
    this.updateBoats();
    this.updateWarships();
    this.updateFlood();
    this.updateAlliances();
    this.grow();
    if (this.tick % this.sweepInterval === 0) this.sweepEnclosures();
    for (const p of this.players) if (p.tiles > p.peakTiles) p.peakTiles = p.tiles;
    this.checkEnd();
    this.tick++;
  }

  /** Order-sensitive digest of the game state, for spotting desyncs. */
  hash(): number {
    let h = 2166136261;
    for (let i = 0; i < this.size; i++) h = Math.imul(h ^ this.owner[i], 16777619);
    for (const p of this.players) {
      h = Math.imul(h ^ Math.floor(p.troops), 16777619);
      h = Math.imul(h ^ Math.floor(p.gold), 16777619);
      h = Math.imul(h ^ p.tiles, 16777619);
      h = Math.imul(h ^ p.capital, 16777619);
    }
    for (const b of this.buildingsByTile.values()) h = Math.imul(h ^ (b.tile * 4 + b.owner), 16777619);
    for (const m of this.missileList) h = Math.imul(h ^ m.to, 16777619);
    for (const t of this.trainList) h = Math.imul(h ^ (t.leg * 1000 + Math.floor(t.progress)), 16777619);
    for (const b of this.boatList) h = Math.imul(h ^ Math.floor(b.pos * 10 + b.troops), 16777619);
    for (const s of this.shipList) h = Math.imul(h ^ (s.tile * 8 + s.hp), 16777619);
    for (const [key, ends] of this.alliances) h = Math.imul(h ^ (ends + key.length), 16777619);
    return h >>> 0;
  }

  // Intents

  private apply(intent: Intent): void {
    this.log.push({ tick: this.tick, intent });
    this.execute(intent);
  }

  private execute(intent: Intent): void {
    if (!this.isPlayerId(intent.player)) return;
    const p = this.player(intent.player);
    if (intent.type === 'spawn') {
      if (this.phase === 'spawn' && !p.bot && !p.spawned && this.isSpawnable(intent.tile)) this.spawnAt(p, intent.tile);
      return;
    }
    if (this.phase !== 'play' || !p.alive) return;
    if (intent.type === 'attack') {
      const permille = Math.max(1, Math.min(1000, Math.floor(intent.permille)));
      this.launch(p, intent.target, Math.floor((p.troops * permille) / 1000));
    } else if (intent.type === 'build') {
      if (!BUILDING_KINDS.includes(intent.kind) || this.canBuild(p, intent.kind, intent.tile) !== null) return;
      p.gold -= this.buildCost(p, intent.kind);
      this.buildingsByTile.set(intent.tile, { id: this.nextId++, kind: intent.kind, tile: intent.tile, owner: p.id });
      p.owned[intent.kind]++;
      if (intent.kind === 'defense') this.postsOf(p.id).push(intent.tile);
    } else if (intent.type === 'recall') {
      // Call an attack off: the surviving troops come home.
      const a = this.findAttack(p.id, intent.target);
      if (a) this.finish(a);
    } else if (intent.type === 'boat') {
      this.sendBoat(p, intent.tile, intent.permille);
    } else if (intent.type === 'warship') {
      this.orderWarship(p, intent.tile);
    } else if (intent.type === 'ally') {
      this.proposeAlliance(p, intent.target);
    } else if (intent.type === 'breakAlly') {
      if (this.isPlayerId(intent.target) && this.allied(p.id, intent.target)) this.endAlliance(p.id, intent.target, p.id);
    } else if (intent.type === 'launch') {
      if (!(intent.kind in CONFIG.missiles) || intent.tile < 0 || intent.tile >= this.size) return;
      if (this.allied(p.id, this.owner[intent.tile])) return;
      if (this.canLaunch(p, intent.kind) !== null) return;
      this.fireMissile(p, intent.kind, intent.tile);
    }
  }

  private runBots(): void {
    for (const p of this.players) {
      const brain = p.brain;
      if (!brain || !p.alive || (this.tick + brain.offset) % brain.every !== 0) continue;
      // Bots run inside the simulation on every client, so their intents are not logged.
      for (const intent of botThink(this, p, this.rng)) this.execute(intent);
    }
  }

  // Spawning

  /** Humans may start anywhere on land except mountains; bots only on the continent. */
  isSpawnable(tile: number, mainlandOnly = false): boolean {
    return (
      this.isLand(tile) &&
      (!mainlandOnly || this.map.mainland[tile] === 1) &&
      this.owner[tile] === NEUTRAL &&
      this.terrain[tile] !== Terrain.Mountains
    );
  }

  private spawnAt(p: Player, tile: number): void {
    const r = CONFIG.spawnRadius;
    const cx = tile % this.width;
    const cy = (tile - cx) / this.width;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (dx * dx + dy * dy > r * r + 1 || x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        const t = y * this.width + x;
        if (this.terrain[t] !== Terrain.Water && this.owner[t] === NEUTRAL) this.conquer(t, p.id);
      }
    }
    p.capital = tile;
    p.troops = CONFIG.startTroops;
    p.spawned = true;
  }

  /** Scatters bots across the map, keeping them apart from each other and from humans. */
  private spawnBots(): void {
    let spacing = Math.sqrt(this.map.landTiles / this.players.length) * 0.75;
    for (const p of this.players) {
      if (p.spawned) continue;
      let placed = false;
      while (!placed && spacing >= 0.5) {
        for (let attempt = 0; attempt < 400 && !placed; attempt++) {
          const t = this.rng.int(this.size);
          if (!this.isSpawnable(t, true) || this.nearCapital(t, spacing)) continue;
          this.spawnAt(p, t);
          placed = true;
        }
        if (!placed) spacing *= 0.8;
      }
      if (!placed) {
        // The map is full. Sit this match out.
        p.alive = false;
        p.spawned = true;
      }
    }
  }

  private nearCapital(tile: number, distance: number): boolean {
    const x = tile % this.width;
    const y = (tile - x) / this.width;
    for (const p of this.players) {
      if (p.capital < 0) continue;
      const cx = p.capital % this.width;
      const dx = cx - x;
      const dy = (p.capital - cx) / this.width - y;
      if (dx * dx + dy * dy < distance * distance) return true;
    }
    return false;
  }

  // Attacks

  private launch(p: Player, target: number, troops: number): void {
    if (troops < 1 || target === p.id || (target !== NEUTRAL && !this.isPlayerId(target))) return;
    const enemy = target === NEUTRAL ? null : this.player(target);
    if (enemy && (!enemy.alive || this.allied(p.id, target))) return;
    if (!this.sharesBorder(p, target)) return;
    p.troops -= troops;
    this.deploy(p, target, troops);
  }

  /** Puts troops already taken from `p` into an attack on `target`. */
  private deploy(p: Player, target: number, troops: number): void {
    const enemy = target === NEUTRAL ? null : this.player(target);
    if (enemy && !enemy.alive) {
      p.troops += troops;
      return;
    }

    // Attacking someone who is attacking you: the two armies meet first.
    if (enemy) {
      const counter = this.findAttack(target, p.id);
      if (counter) {
        const clash = Math.min(counter.troops, troops);
        counter.troops -= clash;
        troops -= clash;
        if (counter.troops < 1) counter.done = true;
        if (troops < 1) return;
      }
    }

    let attack = this.findAttack(p.id, target);
    if (attack) {
      attack.troops += troops;
    } else {
      attack = { attacker: p.id, target, troops, frontier: new TileHeap(), done: false };
      this.attackList.push(attack);
    }
    this.seedFrontier(attack, p);
  }

  private findAttack(attacker: number, target: number): Attack | undefined {
    return this.attackList.find((a) => !a.done && a.attacker === attacker && a.target === target);
  }

  private seedFrontier(a: Attack, p: Player): void {
    const { width, size } = this;
    for (const t of p.border) {
      const x = t % width;
      if (x > 0) this.enqueue(a, t - 1);
      if (x < width - 1) this.enqueue(a, t + 1);
      if (t >= width) this.enqueue(a, t - width);
      if (t + width < size) this.enqueue(a, t + width);
    }
  }

  private enqueue(a: Attack, tile: number): void {
    if (this.owner[tile] !== a.target || this.terrain[tile] === Terrain.Water) return;
    // Hills and mountains are slow going; this tile's own ground decides, not the front's.
    let delay = CONFIG.terrainDelay[this.terrain[tile]] + this.rng.int(CONFIG.delayJitter + 1);
    if (a.target !== NEUTRAL) delay += CONFIG.enemyDelay;
    if (this.defended(tile, a.target)) delay += CONFIG.defenseDelay;
    // Tiles already surrounded on several sides fall sooner, which keeps fronts smooth.
    delay -= this.ownedNeighbors(tile, a.attacker) - 1;
    // Keys are in tenths of a tick, so the speed multipliers aren't lost to rounding.
    const speed = CONFIG.troopSpeed * this.pressure(a);
    a.frontier.push(this.tick * SUBTICKS + Math.max(SUBTICKS, Math.round((delay * SUBTICKS) / speed)), tile);
  }

  /** How much faster (or slower) an attack moves for outnumbering (or not) the defender. */
  pressure(a: Attack): number {
    if (a.target === NEUTRAL) return 1;
    const ratio = a.troops / Math.max(1, this.player(a.target).troops);
    return Math.min(CONFIG.pressureMax, Math.max(CONFIG.pressureMin, Math.sqrt(ratio)));
  }

  private ownedNeighbors(tile: number, id: number): number {
    const { owner, width, size } = this;
    const x = tile % width;
    let n = 0;
    if (x > 0 && owner[tile - 1] === id) n++;
    if (x < width - 1 && owner[tile + 1] === id) n++;
    if (tile >= width && owner[tile - width] === id) n++;
    if (tile + width < size && owner[tile + width] === id) n++;
    return n;
  }

  /** Troops it would cost to take this tile now (0 for your own or water). Pure: safe for the client. */
  costToTake(tile: number, attacker: number): number {
    if (!this.isLand(tile) || this.owner[tile] === attacker) return 0;
    return this.tileCost(tile, this.owner[tile]);
  }

  private tileCost(tile: number, target: number): number {
    const terrainCost =
      CONFIG.terrainCost[this.terrain[tile]] *
      (this.fallout[tile] > this.tick ? CONFIG.falloutCostFactor : 1);
    if (target === NEUTRAL) return CONFIG.neutralCost * terrainCost;
    const d = this.player(target);
    const cost = (CONFIG.neutralCost + (CONFIG.defenseFactor * d.troops) / d.tiles) * terrainCost;
    return this.defended(tile, target) ? cost * CONFIG.defenseCostFactor : cost;
  }

  /** Whether a defence post of `owner` covers this tile. */
  private defended(tile: number, owner: number): boolean {
    if (owner === NEUTRAL) return false;
    const posts = this.posts.get(owner);
    if (!posts || posts.length === 0) return false;
    const r = CONFIG.defenseRadius;
    const x = tile % this.width;
    const y = (tile - x) / this.width;
    for (const post of posts) {
      const bx = post % this.width;
      const dx = bx - x;
      const dy = (post - bx) / this.width - y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  private postsOf(owner: number): number[] {
    let list = this.posts.get(owner);
    if (!list) this.posts.set(owner, (list = []));
    return list;
  }

  private dropPost(owner: number, tile: number): void {
    const list = this.posts.get(owner);
    const i = list ? list.indexOf(tile) : -1;
    if (list && i >= 0) list.splice(i, 1);
  }

  // Trains

  private updateTrains(): void {
    // A factory sends a train once per interval (staggered by id) if none of its own is out.
    for (const b of this.buildingsByTile.values()) {
      if (b.kind !== 'factory' || (this.tick + b.id * 37) % CONFIG.trainInterval !== 0) continue;
      if (this.trainList.some((t) => t.route[0] === b.tile)) continue;
      const stops = this.railRoute(b);
      if (stops.length === 0) continue;
      this.trainList.push({ id: this.nextId++, owner: b.owner, route: [b.tile, ...stops, b.tile], leg: 1, progress: 0 });
    }
    if (this.trainList.length === 0) return;
    const w = this.width;
    for (const t of this.trainList) {
      t.progress += CONFIG.trainSpeed;
      for (;;) {
        const a = t.route[t.leg - 1];
        const b = t.route[t.leg];
        const dx = (a % w) - (b % w);
        const dy = Math.floor(a / w) - Math.floor(b / w);
        const length = Math.sqrt(dx * dx + dy * dy);
        if (t.progress < length) break;
        t.progress -= length;
        // Pays at each of the owner's cities and ports still standing on its route.
        const stop = this.buildingsByTile.get(b);
        // Each stop pays at most once per interval, however many trains pass.
        if (
          t.leg < t.route.length - 1 &&
          stop &&
          stop.owner === t.owner &&
          this.player(t.owner).alive &&
          (stop.paidAt === undefined || this.tick - stop.paidAt >= CONFIG.trainInterval)
        ) {
          stop.paidAt = this.tick;
          this.player(t.owner).gold += CONFIG.trainStopGold;
          this.events.push({ type: 'trainStop', owner: t.owner, tile: b, gold: CONFIG.trainStopGold });
        }
        t.leg++;
        if (t.leg >= t.route.length) break;
      }
    }
    this.trainList = this.trainList.filter((t) => t.leg < t.route.length);
  }

  // Boats

  private sendBoat(p: Player, tile: number, permille: number): void {
    const plan = this.planBoat(p, tile);
    if (typeof plan === 'string') return;
    const troops = Math.floor((p.troops * Math.max(1, Math.min(1000, Math.floor(permille)))) / 1000);
    if (troops < 1) return;
    p.troops -= troops;
    this.boatList.push({ id: this.nextId++, owner: p.id, troops, path: plan.path, pos: 0 });
  }

  private updateBoats(): void {
    if (this.boatList.length === 0) return;
    const landed: Boat[] = [];
    for (const b of this.boatList) {
      b.pos += CONFIG.boatSpeed;
      if (b.pos >= b.path.length - 1) landed.push(b);
    }
    if (landed.length === 0) return;
    this.boatList = this.boatList.filter((b) => b.pos < b.path.length - 1);
    for (const b of landed) this.land(b);
  }

  /** Troops come ashore: take the beach, then push inland from it. */
  private land(b: Boat): void {
    const p = this.player(b.owner);
    const beach = b.path[b.path.length - 1];
    const target = this.owner[beach];
    if (!p.alive) return;
    if (this.terrain[beach] === Terrain.Water) {
      // The beach went under while they sailed: back to the reserves.
      p.troops += b.troops;
      return;
    }
    if (target === p.id || this.allied(p.id, target)) {
      p.troops += b.troops;
      return;
    }
    const cost = this.tileCost(beach, target);
    if (b.troops < cost) {
      this.events.push({ type: 'repelled', owner: p.id, tile: beach, target });
      return;
    }
    let troops = b.troops - cost;
    if (target !== NEUTRAL) {
      const d = this.player(target);
      d.troops -= d.troops / d.tiles;
    }
    this.conquer(beach, p.id);
    this.events.push({ type: 'landed', owner: p.id, tile: beach, target });
    if (target !== NEUTRAL && !this.player(target).alive) {
      p.troops += troops;
      return;
    }
    // A little goes into holding the beach; the rest marches on.
    troops = Math.max(0, troops);
    this.deploy(p, target, troops);
  }

  // Warships

  /**
   * Sends a warship to a water tile: a new one from the nearest port if
   * `p` may have another, otherwise the nearest ship already afloat.
   */
  private orderWarship(p: Player, tile: number): void {
    if (!this.isWater(tile)) return;
    const mine = this.shipList.filter((s) => s.owner === p.id);
    if (this.canWarship(p) === null) {
      const route = this.waterRoute(tile, (t) => this.besidePort(t, p.id));
      if (!route) return;
      route.reverse();
      p.gold -= CONFIG.warship.cost;
      this.shipList.push({ id: this.nextId++, owner: p.id, tile: route[0], hp: CONFIG.warship.hp, route: route.slice(1), station: tile });
      return;
    }
    if (mine.length === 0) return;
    const ids = new Set(mine.map((s) => s.tile));
    const route = this.waterRoute(tile, (t) => ids.has(t));
    if (!route) return;
    route.reverse();
    const ship = mine.find((s) => s.tile === route[0])!;
    ship.route = route.slice(1);
    ship.station = tile;
  }

  private updateWarships(): void {
    if (this.shipList.length === 0) return;
    const ws = CONFIG.warship;
    const w = this.width;
    const dist2 = (a: number, b: number) => {
      const dx = (a % w) - (b % w);
      const dy = Math.floor(a / w) - Math.floor(b / w);
      return dx * dx + dy * dy;
    };
    const range2 = ws.range * ws.range;
    this.shipList = this.shipList.filter((s) => this.player(s.owner).alive);

    for (const s of this.shipList) {
      // Sailing, or roaming about its station.
      if ((this.tick + s.id) % ws.pace === 0) {
        if (s.route.length > 0) s.tile = s.route.shift()!;
        else if (this.rng.next() < 0.1) {
          const sx = s.station % w;
          const sy = Math.floor(s.station / w);
          const tx = sx + this.rng.int(2 * ws.patrol + 1) - ws.patrol;
          const ty = sy + this.rng.int(2 * ws.patrol + 1) - ws.patrol;
          const target = ty * w + tx;
          if (tx >= 0 && ty >= 0 && tx < w && ty < this.height && this.isWater(target)) {
            s.route = (this.waterRoute(s.tile, (t) => t === target, 4000) ?? [s.tile]).slice(1);
          }
        }
      }
      if ((this.tick + s.id) % ws.fireEvery !== 0) continue;
      // Guns: the nearest enemy ship first, then boats.
      let enemy: Warship | null = null;
      let best = Infinity;
      for (const o of this.shipList) {
        if (o.owner === s.owner || o.hp <= 0 || this.allied(o.owner, s.owner)) continue;
        const d = dist2(s.tile, o.tile);
        if (d <= range2 && d < best) {
          best = d;
          enemy = o;
        }
      }
      if (enemy) {
        enemy.hp--;
        if (enemy.hp <= 0) this.events.push({ type: 'shipSunk', owner: enemy.owner, by: s.owner, tile: enemy.tile });
        continue;
      }
      const boat = this.boatList.find((b) => {
        if (b.owner === s.owner || this.allied(b.owner, s.owner)) return false;
        const at = b.path[Math.min(b.path.length - 1, Math.floor(b.pos))];
        return dist2(s.tile, at) <= range2;
      });
      if (boat) {
        this.boatList = this.boatList.filter((b) => b !== boat);
        this.events.push({ type: 'sunk', owner: boat.owner, by: s.owner, troops: boat.troops });
      }
    }
    this.shipList = this.shipList.filter((s) => s.hp > 0);

    // Shore bombardment: the nearest enemy land tile in range, unless a bunker covers it.
    for (const s of this.shipList) {
      if ((this.tick + s.id * 7) % ws.shellEvery !== 0) continue;
      const sx = s.tile % w;
      const sy = Math.floor(s.tile / w);
      let target = -1;
      let best = Infinity;
      for (let dy = -ws.range; dy <= ws.range; dy++) {
        for (let dx = -ws.range; dx <= ws.range; dx++) {
          const x = sx + dx;
          const y = sy + dy;
          const d = dx * dx + dy * dy;
          if (d > range2 || d >= best || x < 0 || y < 0 || x >= w || y >= this.height) continue;
          const t = y * w + x;
          const o = this.owner[t];
          if (o === NEUTRAL || o === s.owner || this.allied(o, s.owner) || this.defended(t, o)) continue;
          best = d;
          target = t;
        }
      }
      if (target < 0) continue;
      const victim = this.player(this.owner[target]);
      victim.troops -= victim.troops / victim.tiles;
      const b = this.buildingsByTile.get(target);
      if (b) {
        this.buildingsByTile.delete(target);
        victim.owned[b.kind]--;
      }
      this.release(target);
      // Cratered: it stays neutral for a while rather than being swept back in as a pocket.
      this.fallout[target] = this.tick + CONFIG.falloutTicks;
      this.events.push({ type: 'shelled', tile: target, owner: victim.id, by: s.owner });
      if (victim.tiles === 0) this.eliminate(victim, s.owner);
      else if (this.owner[victim.capital] !== victim.id) this.loseCapital(victim, s.owner);
    }
  }

  // Battle royale

  /** Land tiles from the outside in: distance from the middle, roughened so the coast stays ragged. */
  private planFlood(seed: number): Int32Array {
    const { width: w, height: h, size, terrain } = this;
    const tiles: number[] = [];
    const score = new Float64Array(size);
    for (let t = 0; t < size; t++) {
      if (terrain[t] === Terrain.Water) continue;
      const x = t % w;
      const y = (t - x) / w;
      const dx = (x - w / 2) / (w / 2);
      const dy = (y - h / 2) / (h / 2);
      const rough = fbm(seed + 77, x / 70, y / 70, 3) * 0.35;
      score[t] = Math.sqrt(dx * dx + dy * dy) + rough;
      tiles.push(t);
    }
    tiles.sort((a, b) => score[b] - score[a] || a - b);
    return Int32Array.from(tiles);
  }

  /** How many land tiles the sea has taken by this tick. */
  private floodTarget(tick: number): number {
    const order = this.floodOrder!;
    const { grace, duration, share } = CONFIG.royale;
    const progress = Math.min(1, Math.max(0, (tick - grace) / duration));
    return Math.floor(order.length * share * progress);
  }

  /** Ticks until the sea starts rising, 0 once it has (battle royale only). */
  floodStartsIn(): number {
    return this.floodOrder ? Math.max(0, CONFIG.royale.grace - this.tick) : 0;
  }

  private updateFlood(): void {
    const order = this.floodOrder;
    if (!order) return;
    // Mark what's coming, so it can be seen in time.
    const warn = this.floodTarget(this.tick + CONFIG.royale.warning);
    while (this.doomedCount < warn) {
      const t = order[this.doomedCount++];
      this.doomed[t] = 1;
      this.changed.push(t);
    }
    const target = this.floodTarget(this.tick);
    if (this.floodedCount >= target) return;
    const tiles: number[] = [];
    const hit = new Set<number>();
    while (this.floodedCount < target) {
      const t = order[this.floodedCount++];
      const o = this.owner[t];
      if (o !== NEUTRAL) {
        const v = this.player(o);
        v.troops -= v.troops / v.tiles;
        this.release(t);
        hit.add(o);
      }
      const b = this.buildingsByTile.get(t);
      if (b) {
        this.buildingsByTile.delete(t);
        this.player(b.owner).owned[b.kind]--;
        if (b.kind === 'defense') this.dropPost(b.owner, t);
      }
      this.terrain[t] = Terrain.Water;
      this.doomed[t] = 0;
      this.fallout[t] = 0;
      (this.map as { landTiles: number }).landTiles--;
      const x = t % this.width;
      if (x > 0) this.refreshBorder(t - 1);
      if (x < this.width - 1) this.refreshBorder(t + 1);
      if (t >= this.width) this.refreshBorder(t - this.width);
      if (t + this.width < this.size) this.refreshBorder(t + this.width);
      this.changed.push(t);
      tiles.push(t);
    }
    for (const id of hit) {
      const v = this.player(id);
      if (!v.alive) continue;
      if (v.tiles === 0) this.eliminate(v, NEUTRAL);
      else if (this.owner[v.capital] !== v.id) this.loseCapital(v, NEUTRAL);
    }
    this.events.push({ type: 'flooded', tiles });
  }

  // Alliances

  private proposeAlliance(p: Player, target: number): void {
    if (!this.isPlayerId(target) || target === p.id) return;
    const q = this.player(target);
    const key = this.pairKey(p.id, target);
    if (!q.alive || this.alliances.has(key)) return;
    if ((this.cooldowns.get(key) ?? 0) > this.tick) {
      this.events.push({ type: 'alliance', from: p.id, to: target, accepted: false });
      return;
    }
    let accepted: boolean;
    if (this.offers.has(`${target}:${p.id}`)) {
      // Answering an open offer seals it.
      accepted = true;
      this.offers.delete(`${target}:${p.id}`);
    } else if (q.bot) {
      // Bots side with players who aren't much smaller than they are, most of the time.
      accepted = q.tiles <= p.tiles * 2 && this.rng.next() < 0.75;
    } else {
      // Humans answer for themselves: leave them an offer.
      if (!this.offers.has(`${p.id}:${target}`)) {
        this.offers.set(`${p.id}:${target}`, this.tick + CONFIG.allianceOfferTicks);
        this.events.push({ type: 'allianceOffer', from: p.id, to: target });
      }
      return;
    }
    if (!accepted) {
      this.cooldowns.set(key, this.tick + CONFIG.allianceCooldown);
      this.events.push({ type: 'alliance', from: p.id, to: target, accepted: false });
      return;
    }
    this.alliances.set(key, this.tick + CONFIG.allianceTicks);
    // Call off fighting between the new allies; the troops go home.
    for (const a of this.attackList) {
      if ((a.attacker === p.id && a.target === target) || (a.attacker === target && a.target === p.id)) this.finish(a);
    }
    this.events.push({ type: 'alliance', from: p.id, to: target, accepted: true });
  }

  private endAlliance(a: number, b: number, brokenBy: number): void {
    const key = this.pairKey(a, b);
    this.alliances.delete(key);
    this.cooldowns.set(key, this.tick + CONFIG.allianceCooldown);
    this.events.push({ type: 'allianceEnded', a, b, brokenBy });
  }

  /** Whether `from` has an open alliance offer out to `to`. */
  hasOffer(from: number, to: number): boolean {
    return this.offers.has(`${from}:${to}`);
  }

  /** Tick an open offer from `from` to `to` lapses, or 0 if there is none. */
  offerLapses(from: number, to: number): number {
    return this.offers.get(`${from}:${to}`) ?? 0;
  }

  private updateAlliances(): void {
    for (const [key, lapses] of this.offers) {
      if (lapses > this.tick) continue;
      // Left unanswered: treat it as a no, so the same player doesn't ask again straight away.
      this.offers.delete(key);
      const [a, b] = key.split(':').map(Number);
      this.cooldowns.set(this.pairKey(a, b), this.tick + CONFIG.allianceCooldown);
    }
    for (const [key, ends] of this.alliances) {
      const [a, b] = key.split(':').map(Number);
      if (ends <= this.tick || !this.player(a).alive || !this.player(b).alive) this.endAlliance(a, b, NEUTRAL);
    }
  }

  // Missiles

  private fireMissile(p: Player, kind: MissileKind, target: number): void {
    // Launch from the silo nearest the target.
    const tx = target % this.width;
    const ty = (target - tx) / this.width;
    let from = -1;
    let best = Infinity;
    for (const b of this.buildingsByTile.values()) {
      if (b.kind !== 'silo' || b.owner !== p.id || (b.readyAt ?? 0) > this.tick) continue;
      const bx = b.tile % this.width;
      const by = (b.tile - bx) / this.width;
      const d = (bx - tx) * (bx - tx) + (by - ty) * (by - ty);
      if (d < best) {
        best = d;
        from = b.tile;
      }
    }
    if (from < 0) return;
    this.buildingsByTile.get(from)!.readyAt = this.tick + CONFIG.siloReload;
    p.gold -= this.missileCost(kind);
    const flight = Math.max(CONFIG.missileMinFlight, Math.ceil(Math.sqrt(best) / CONFIG.missileSpeed));
    const missile: Missile = {
      id: this.nextId++,
      kind,
      owner: p.id,
      from,
      to: target,
      victim: this.owner[target],
      launched: this.tick,
      arrives: this.tick + flight,
    };
    this.missileList.push(missile);
    this.events.push({ type: 'launched', missile });
  }

  private updateMissiles(): void {
    if (this.missileList.length === 0) return;
    const landing = this.missileList.filter((m) => m.arrives <= this.tick);
    if (landing.length === 0) return;
    this.missileList = this.missileList.filter((m) => m.arrives > this.tick);
    for (const m of landing) this.impact(m);
  }

  /** Wipes out everything in the blast: land turns neutral, buildings are destroyed. */
  private impact(m: Missile): void {
    const r = CONFIG.missiles[m.kind].radius;
    const cx = m.to % this.width;
    const cy = (m.to - cx) / this.width;
    const hit: number[] = [];
    let buildings = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (dx * dx + dy * dy > r * r || x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        const t = y * this.width + x;
        if (this.terrain[t] !== Terrain.Water) this.fallout[t] = this.tick + CONFIG.falloutTicks;
        const b = this.buildingsByTile.get(t);
        if (b) {
          this.buildingsByTile.delete(t);
          this.player(b.owner).owned[b.kind]--;
          if (b.kind === 'defense') this.dropPost(b.owner, t);
          buildings++;
        }
        if (this.owner[t] !== NEUTRAL) hit.push(t);
      }
    }

    const lost = new Map<number, number>();
    for (const t of hit) lost.set(this.owner[t], (lost.get(this.owner[t]) ?? 0) + 1);
    for (const [id, tiles] of lost) {
      const v = this.player(id);
      v.troops = Math.max(0, v.troops - ((v.troops * tiles) / v.tiles) * CONFIG.missileTroopLoss);
    }
    for (const t of hit) this.release(t);
    for (const id of lost.keys()) {
      const v = this.player(id);
      if (v.tiles === 0) this.eliminate(v, m.owner);
      else if (this.owner[v.capital] !== v.id) this.loseCapital(v, m.owner);
    }
    const losses = [...lost].map(([player, tiles]) => ({ player, tiles }));
    this.events.push({ type: 'impact', missile: m, losses, buildings });
  }

  /** Makes an owned tile neutral. The caller handles capitals and elimination. */
  private release(tile: number): void {
    const { width, size } = this;
    const prev = this.player(this.owner[tile]);
    const x = tile % width;
    this.removeBorder(tile, prev);
    prev.tiles--;
    prev.sumX -= x;
    prev.sumY -= (tile - x) / width;
    this.owner[tile] = NEUTRAL;
    if (x > 0) this.refreshBorder(tile - 1);
    if (x < width - 1) this.refreshBorder(tile + 1);
    if (tile >= width) this.refreshBorder(tile - width);
    if (tile + width < size) this.refreshBorder(tile + width);
    this.changed.push(tile);
  }

  private updateAttacks(): void {
    for (const a of this.attackList) {
      if (a.done) continue;
      if (!this.player(a.attacker).alive) {
        a.done = true;
        continue;
      }
      if (a.target !== NEUTRAL && !this.player(a.target).alive) {
        this.finish(a);
        continue;
      }
      this.advance(a);
    }
    this.attackList = this.attackList.filter((a) => !a.done);
  }

  private advance(a: Attack): void {
    const { owner, width, size } = this;
    const heap = a.frontier;
    const defender = a.target === NEUTRAL ? null : this.player(a.target);

    while (heap.size > 0 && heap.peekKey() <= this.tick * SUBTICKS) {
      const t = heap.pop();
      // Skip tiles someone else took, the sea swallowed, or that lost contact with our front.
      if (owner[t] !== a.target || this.terrain[t] === Terrain.Water || this.ownedNeighbors(t, a.attacker) === 0) continue;
      const cost = this.tileCost(t, a.target);
      if (a.troops < cost) {
        // Too dear for what's left (a peak, a bunker): leave that tile and keep pushing elsewhere.
        if (a.troops < CONFIG.neutralCost) {
          this.finish(a);
          return;
        }
        continue;
      }
      a.troops -= cost;
      // The troops stationed on the tile die with it; a bunker shelters half of them.
      if (defender) {
        const loss = defender.troops / defender.tiles;
        defender.troops -= this.defended(t, a.target) ? loss * CONFIG.defenseLossFactor : loss;
      }
      this.conquer(t, a.attacker);
      if (defender && !defender.alive) {
        this.finish(a);
        return;
      }
      const x = t % width;
      if (x > 0) this.enqueue(a, t - 1);
      if (x < width - 1) this.enqueue(a, t + 1);
      if (t >= width) this.enqueue(a, t - width);
      if (t + width < size) this.enqueue(a, t + width);
    }
    if (heap.size === 0) this.finish(a);
  }

  /** Ends an attack and sends its surviving troops home. */
  private finish(a: Attack): void {
    if (a.done) return;
    a.done = true;
    const p = this.player(a.attacker);
    if (p.alive) p.troops += a.troops;
    a.troops = 0;
  }

  // Territory

  private conquer(tile: number, id: number): void {
    const { width, size } = this;
    const old = this.owner[tile];
    const x = tile % width;
    const y = (tile - x) / width;
    if (old !== NEUTRAL) {
      const prev = this.player(old);
      this.removeBorder(tile, prev);
      prev.tiles--;
      prev.sumX -= x;
      prev.sumY -= y;
    }
    const next = this.player(id);
    this.owner[tile] = id;
    next.tiles++;
    next.sumX += x;
    next.sumY += y;

    this.refreshBorder(tile);
    if (x > 0) this.refreshBorder(tile - 1);
    if (x < width - 1) this.refreshBorder(tile + 1);
    if (tile >= width) this.refreshBorder(tile - width);
    if (tile + width < size) this.refreshBorder(tile + width);
    this.changed.push(tile);

    const building = this.buildingsByTile.get(tile);
    if (building && building.owner !== id && building.kind === 'defense') {
      // Bunkers don't change hands: whoever overruns one blows it up.
      this.player(building.owner).owned.defense--;
      this.dropPost(building.owner, tile);
      this.buildingsByTile.delete(tile);
      this.events.push({ type: 'bunkerDestroyed', tile, from: building.owner, by: id });
    } else if (building && building.owner !== id) {
      this.player(building.owner).owned[building.kind]--;
      next.owned[building.kind]++;
      if (building.kind === 'defense') {
        this.dropPost(building.owner, tile);
        this.postsOf(id).push(tile);
      }
      this.events.push({ type: 'captured', kind: building.kind, tile, from: building.owner, by: id });
      building.owner = id;
    }

    if (old !== NEUTRAL) {
      const prev = this.player(old);
      if (prev.tiles === 0) this.eliminate(prev, id);
      else if (prev.capital === tile) this.loseCapital(prev, id);
    }
  }

  /** Adds or removes a tile from its owner's border list to match its neighbours. */
  private refreshBorder(tile: number): void {
    const o = this.owner[tile];
    if (o === NEUTRAL) return;
    const { owner, terrain, width, size } = this;
    const x = tile % width;
    const onBorder =
      (x > 0 && owner[tile - 1] !== o && terrain[tile - 1] !== Terrain.Water) ||
      (x < width - 1 && owner[tile + 1] !== o && terrain[tile + 1] !== Terrain.Water) ||
      (tile >= width && owner[tile - width] !== o && terrain[tile - width] !== Terrain.Water) ||
      (tile + width < size && owner[tile + width] !== o && terrain[tile + width] !== Terrain.Water);
    const listed = this.borderPos[tile] >= 0;
    if (onBorder && !listed) {
      const list = this.player(o).border;
      this.borderPos[tile] = list.length;
      list.push(tile);
    } else if (!onBorder && listed) {
      this.removeBorder(tile, this.player(o));
    }
  }

  private removeBorder(tile: number, p: Player): void {
    const pos = this.borderPos[tile];
    if (pos < 0) return;
    const last = p.border.pop()!;
    if (last !== tile) {
      p.border[pos] = last;
      this.borderPos[last] = pos;
    }
    this.borderPos[tile] = -1;
  }

  private loseCapital(p: Player, by: number): void {
    p.troops *= 1 - CONFIG.capitalPenalty;
    p.capital = this.pickCapital(p);
    this.events.push({ type: 'capitalLost', player: p.id, by });
  }

  /** The owned tile nearest the middle of the territory, preferring tiles away from the border. */
  private pickCapital(p: Player): number {
    const cx = p.sumX / p.tiles;
    const cy = p.sumY / p.tiles;
    let best = -1;
    let bestScore = Infinity;
    for (let t = 0; t < this.size; t++) {
      if (this.owner[t] !== p.id) continue;
      const x = t % this.width;
      const y = (t - x) / this.width;
      const penalty = this.borderPos[t] >= 0 ? 1e9 : 0;
      const score = (x - cx) * (x - cx) + (y - cy) * (y - cy) + penalty;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  private eliminate(p: Player, by: number): void {
    p.alive = false;
    p.troops = 0;
    p.capital = -1;
    p.place = this.players.filter((q) => q.alive).length + 1;
    for (const a of this.attackList) if (a.attacker === p.id) a.done = true;
    this.events.push({ type: 'eliminated', player: p.id, by });
  }

  /**
   * Finds land cut off by a single player and hands it over: pockets of
   * neutral land inside someone's territory, and enemy fragments that no
   * longer connect to their capital.
   */
  private sweepEnclosures(): void {
    const { owner, terrain, width, size, seen, stack, component } = this;
    const stamp = ++this.sweepStamp;

    for (let start = 0; start < size; start++) {
      if (terrain[start] === Terrain.Water || seen[start] === stamp) continue;
      const o = owner[start];
      const capital = o === NEUTRAL ? -1 : this.player(o).capital;
      let top = 0;
      let count = 0;
      let surrounding = -1;
      let mixed = false;
      let hasCapital = false;
      let contaminated = false;
      let coastal = false;
      stack[top++] = start;
      seen[start] = stamp;

      while (top > 0) {
        const t = stack[--top];
        component[count++] = t;
        if (t === capital) hasCapital = true;
        if (this.fallout[t] > this.tick) contaminated = true;
        const x = t % width;
        for (let k = 0; k < 4; k++) {
          let n: number;
          if (k === 0) {
            if (x === 0) continue;
            n = t - 1;
          } else if (k === 1) {
            if (x === width - 1) continue;
            n = t + 1;
          } else if (k === 2) {
            if (t < width) continue;
            n = t - width;
          } else {
            if (t + width >= size) continue;
            n = t + width;
          }
          if (terrain[n] === Terrain.Water) {
            coastal = true;
            continue;
          }
          const no = owner[n];
          if (no === o) {
            if (seen[n] !== stamp) {
              seen[n] = stamp;
              stack[top++] = n;
            }
          } else if (surrounding === -1) {
            surrounding = no;
          } else if (surrounding !== no) {
            mixed = true;
          }
        }
      }

      if (mixed || surrounding <= NEUTRAL) continue;
      const enclosing = this.player(surrounding);
      if (o === NEUTRAL) {
        if (contaminated || count > Math.min(CONFIG.pocketMax, enclosing.tiles * CONFIG.pocketShare)) continue;
      } else if (hasCapital || coastal) {
        // A fragment holding a capital, or on the coast (a beachhead, supplied by sea), isn't cut off.
        continue;
      }
      this.annex(component.subarray(0, count), o, surrounding);
    }
  }

  private annex(tiles: Int32Array, from: number, to: number): void {
    if (from !== NEUTRAL) {
      const p = this.player(from);
      p.troops -= (p.troops * tiles.length) / p.tiles;
      this.events.push({ type: 'encircled', player: from, by: to, tiles: tiles.length });
    }
    for (const t of tiles) this.conquer(t, to);
  }

  // Economy and match state

  private grow(): void {
    for (const p of this.players) {
      if (!p.alive || !p.spawned) continue;
      p.gold += p.tiles * CONFIG.goldPerTile;
      const max = this.maxTroops(p);
      if (p.troops < max) {
        const gain = p.troops * CONFIG.interest * (1 - p.troops / max) + p.tiles * CONFIG.landIncome;
        p.troops = Math.min(max, p.troops + gain);
      } else {
        p.troops -= (p.troops - max) * CONFIG.overflowDecay;
      }
    }
  }

  private checkEnd(): void {
    let alive = 0;
    let leader: Player | null = null;
    for (const p of this.players) {
      if (!p.alive) continue;
      alive++;
      if (!leader || p.tiles > leader.tiles) leader = p;
    }
    if (!leader) return;
    const limit = this.settings.timeLimit;
    const timeUp = limit > 0 && this.tick + 1 >= limit;
    if (alive > 1 && leader.tiles < this.map.landTiles * CONFIG.winShare && !timeUp) return;

    this.phase = 'over';
    this.winner = leader.id;
    const standing = this.players.filter((p) => p.alive).sort((a, b) => b.tiles - a.tiles || a.id - b.id);
    standing.forEach((p, i) => (p.place = i + 1));
    this.events.push({ type: 'gameOver', winner: leader.id });
  }
}
