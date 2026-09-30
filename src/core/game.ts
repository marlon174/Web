import { botThink, createBrain, type BotBrain, type Difficulty } from './bots';
import { CONFIG } from './config';
import { TileHeap } from './heap';
import { Terrain, type GameMap } from './map';
import { Rng } from './rng';

/** Owner id of land nobody holds. Players are numbered from 1. */
export const NEUTRAL = 0;

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

export type BuildingKind = 'city' | 'defense' | 'silo';
export type MissileKind = 'rocket' | 'nuke';
export const BUILDING_KINDS: readonly BuildingKind[] = ['city', 'defense', 'silo'];

export interface Building {
  readonly id: number;
  readonly kind: BuildingKind;
  readonly tile: number;
  owner: number;
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
export type Refusal = 'notYours' | 'tooClose' | 'gold' | 'noSilo' | 'offMap';

export type Intent =
  | { type: 'spawn'; player: number; tile: number }
  | { type: 'attack'; player: number; target: number; permille: number }
  | { type: 'build'; player: number; tile: number; kind: BuildingKind }
  | { type: 'launch'; player: number; tile: number; kind: MissileKind };

export type GameEvent =
  | { type: 'capitalLost'; player: number; by: number }
  | { type: 'eliminated'; player: number; by: number }
  | { type: 'encircled'; player: number; by: number; tiles: number }
  | { type: 'captured'; kind: BuildingKind; tile: number; from: number; by: number }
  | { type: 'launched'; missile: Missile }
  | { type: 'impact'; missile: Missile; losses: { player: number; tiles: number }[]; buildings: number }
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
  /** Position of each tile in its owner's border list, or -1. */
  private readonly borderPos: Int32Array;
  private attackList: Attack[] = [];
  private readonly buildingsByTile = new Map<number, Building>();
  private missileList: Missile[] = [];
  private nextId = 1;
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
    this.map = settings.map;
    this.width = this.map.width;
    this.height = this.map.height;
    this.size = this.width * this.height;
    this.terrain = this.map.terrain;
    this.owner = new Uint16Array(this.size);
    this.fallout = new Int32Array(this.size);
    this.borderPos = new Int32Array(this.size).fill(-1);
    this.seen = new Int32Array(this.size);
    this.stack = new Int32Array(this.size);
    this.component = new Int32Array(this.size);
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
      owned: { city: 0, defense: 0, silo: 0 },
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
    return p.tiles * CONFIG.troopsPerTile * (1 + CONFIG.cityCapBonus * p.owned.city);
  }

  /** Gold price of the next building of this kind for `p`. */
  buildCost(p: Player, kind: BuildingKind): number {
    const { cost, growth } = CONFIG.buildings[kind];
    let price = cost;
    for (let i = 0; i < p.owned[kind]; i++) price *= growth;
    return Math.round(price);
  }

  missileCost(kind: MissileKind): number {
    return CONFIG.missiles[kind].cost;
  }

  /** Null if `p` can put this building on `tile` now, else the reason not. */
  canBuild(p: Player, kind: BuildingKind, tile: number): Refusal | null {
    if (tile < 0 || tile >= this.size) return 'offMap';
    if (this.owner[tile] !== p.id || !p.alive) return 'notYours';
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
    if (p.gold < this.missileCost(kind)) return 'gold';
    return null;
  }

  /**
   * A random free spot for a bot's building: inside its land, or on its
   * border when `front` is set. Uses the simulation's random numbers, so only
   * call it from inside the simulation.
   */
  findSpot(p: Player, kind: BuildingKind, front = false): number {
    for (let attempt = 0; attempt < 60; attempt++) {
      const t = front ? p.border[this.rng.int(p.border.length)] : this.rng.int(this.size);
      if (t === undefined || (!front && this.borderPos[t] >= 0)) continue;
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
    this.grow();
    if (this.tick % CONFIG.sweepEvery === 0) this.sweepEnclosures();
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
    } else if (intent.type === 'launch') {
      if (!(intent.kind in CONFIG.missiles) || intent.tile < 0 || intent.tile >= this.size) return;
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

  private isSpawnable(tile: number): boolean {
    return this.isLand(tile) && this.owner[tile] === NEUTRAL && this.terrain[tile] !== Terrain.Mountains;
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
          if (!this.isSpawnable(t) || this.nearCapital(t, spacing)) continue;
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
    if (enemy && !enemy.alive) return;
    if (!this.sharesBorder(p, target)) return;
    p.troops -= troops;

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
    let delay = CONFIG.terrainDelay[this.terrain[tile]] + this.rng.int(CONFIG.delayJitter + 1);
    if (a.target !== NEUTRAL) delay += CONFIG.enemyDelay;
    if (this.defended(tile, a.target)) delay += CONFIG.defenseDelay;
    // Tiles already surrounded on several sides fall sooner, which keeps fronts smooth.
    delay -= this.ownedNeighbors(tile, a.attacker) - 1;
    a.frontier.push(this.tick + Math.max(1, delay), tile);
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

  private tileCost(tile: number, target: number): number {
    const terrainCost =
      CONFIG.terrainCost[this.terrain[tile]] * (this.fallout[tile] > this.tick ? CONFIG.falloutCostFactor : 1);
    if (target === NEUTRAL) return CONFIG.neutralCost * terrainCost;
    const d = this.player(target);
    const cost = (CONFIG.neutralCost + (CONFIG.defenseFactor * d.troops) / d.tiles) * terrainCost;
    return this.defended(tile, target) ? cost * CONFIG.defenseCostFactor : cost;
  }

  /** Whether a defence post of `owner` covers this tile. */
  private defended(tile: number, owner: number): boolean {
    if (owner === NEUTRAL || this.player(owner).owned.defense === 0) return false;
    const r = CONFIG.defenseRadius;
    const x = tile % this.width;
    const y = (tile - x) / this.width;
    for (const b of this.buildingsByTile.values()) {
      if (b.kind !== 'defense' || b.owner !== owner) continue;
      const bx = b.tile % this.width;
      const dx = bx - x;
      const dy = (b.tile - bx) / this.width - y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  // Missiles

  private fireMissile(p: Player, kind: MissileKind, target: number): void {
    // Launch from the silo nearest the target.
    const tx = target % this.width;
    const ty = (target - tx) / this.width;
    let from = -1;
    let best = Infinity;
    for (const b of this.buildingsByTile.values()) {
      if (b.kind !== 'silo' || b.owner !== p.id) continue;
      const bx = b.tile % this.width;
      const by = (b.tile - bx) / this.width;
      const d = (bx - tx) * (bx - tx) + (by - ty) * (by - ty);
      if (d < best) {
        best = d;
        from = b.tile;
      }
    }
    if (from < 0) return;
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

    while (heap.size > 0 && heap.peekKey() <= this.tick) {
      const t = heap.pop();
      // Skip tiles someone else took, or that lost contact with our front.
      if (owner[t] !== a.target || this.ownedNeighbors(t, a.attacker) === 0) continue;
      const cost = this.tileCost(t, a.target);
      if (a.troops < cost) {
        this.finish(a);
        return;
      }
      a.troops -= cost;
      // The troops stationed on the tile die with it.
      if (defender) defender.troops -= defender.troops / defender.tiles;
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
    if (building && building.owner !== id) {
      this.player(building.owner).owned[building.kind]--;
      next.owned[building.kind]++;
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
          if (terrain[n] === Terrain.Water) continue;
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
      } else if (hasCapital) {
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
