import type { Difficulty } from './bots';
import { CONFIG } from './config';
import type { GameSettings, PlayerSetup } from './game';
import { generateMap, MAP_DIMENSIONS, type GameMap, type MapSize } from './map';
import { buildRealMap, type RealMapId } from './realmaps';
import { Rng } from './rng';

export type Mode = 'quick' | 'classic' | 'royale';

export interface MatchOptions {
  seed: number;
  mode: Mode;
  /** Ignored in quick matches, which always use the small map. */
  mapSize: MapSize;
  bots: number;
  difficulty: Difficulty;
  /** Number of teams (2 or 4), or 0 for everyone on their own. */
  teams?: number;
  /** A real-world map instead of a generated one. */
  world?: RealMapId | null;
  /** The human player, or null for a bots-only match. */
  human: { name: string; color: number } | null;
}

export const QUICK_MATCH_SECONDS = 5 * 60;

const BOT_NAMES = [
  'Ashford', 'Blackfen', 'Brightwater', 'Cinderholt', 'Coldharbor', 'Driftmark', 'Dunmore',
  'Eastmere', 'Emberly', 'Fenwick', 'Glasswind', 'Harrowgate', 'Ironmoor', 'Juniper',
  'Kestrel', 'Larkspur', 'Marrowdeep', 'Northwatch', 'Oakhaven', 'Pinecrest', 'Quarryton',
  'Redcliff', 'Saltmarsh', 'Thornbury', 'Umberfield', 'Valewood', 'Westreach', 'Yarrowby',
  'Zephyr Bay', 'Amberlyn', 'Stonebridge', 'Wolfhollow',
];

export function mapSizeFor(options: MatchOptions): MapSize {
  return options.mode === 'quick' ? 'small' : options.mapSize;
}

export function createMap(options: MatchOptions): GameMap {
  const { width, height } = MAP_DIMENSIONS[mapSizeFor(options)];
  // Real maps keep their own shape at about the same number of tiles.
  if (options.world) return buildRealMap(options.world, width * height, options.seed);
  return generateMap(options.seed, width, height);
}

/** Players, names and colours for a match. The human, if any, is player 1. */
export function createSettings(options: MatchOptions, map: GameMap): GameSettings {
  const rng = new Rng(options.seed ^ 0x5bd1e995);
  const players: PlayerSetup[] = [];
  if (options.human) players.push({ name: options.human.name, color: options.human.color, bot: false });

  const names = botNames(options.bots + 1, rng).filter((n) => n !== options.human?.name);
  const teams = options.teams && options.teams >= 2 ? options.teams : 0;
  const colors = teams ? [] : botColors(options.bots, options.human?.color ?? null, rng);
  for (let i = 0; i < options.bots; i++) {
    const name = i < names.length ? names[i] : `${names[i % names.length]} ${Math.floor(i / names.length) + 1}`;
    players.push({ name, color: colors[i] ?? 0, bot: true });
  }
  if (teams) assignTeams(players, teams, options.human?.color ?? null);

  return {
    seed: options.seed,
    map,
    players,
    difficulty: options.difficulty,
    timeLimit: options.mode === 'quick' ? QUICK_MATCH_SECONDS * CONFIG.ticksPerSecond : 0,
    royale: options.mode === 'royale',
    // Real maps split the land by oceans, so half of it is enough to win.
    winShare: options.world ? 0.5 : undefined,
  };
}

/** Hues for teams after the first; the first team takes its hue from the human's colour. */
const TEAM_HUES = [215, 0, 130, 45];

/**
 * Deals players round the teams (the human, player 1, lands in team 1) and
 * colours each team in shades of one hue, so sides read at a glance.
 */
function assignTeams(players: PlayerSetup[], teams: number, humanColor: number | null): void {
  const hues: number[] = [];
  const first = humanColor !== null ? hueOf(humanColor) : TEAM_HUES[0];
  hues.push(first);
  for (const h of TEAM_HUES) {
    if (hues.length >= teams) break;
    if (hues.every((u) => Math.min(Math.abs(u - h), 360 - Math.abs(u - h)) > 40)) hues.push(h);
  }
  while (hues.length < teams) hues.push((hues[hues.length - 1] + 90) % 360);
  const seen = new Array<number>(teams + 1).fill(0);
  players.forEach((p, i) => {
    const team = (i % teams) + 1;
    p.team = team;
    const k = seen[team]++;
    if (p.bot || humanColor === null) {
      // Same hue for the whole team; members differ in lightness and saturation.
      const hue = (hues[team - 1] + ((k % 3) - 1) * 3 + 360) % 360;
      p.color = hslToRgb(hue, [0.55, 0.45, 0.65, 0.4, 0.6][k % 5], [0.62, 0.48, 0.7, 0.4, 0.55][k % 5]);
    }
  });
}

const PREFIXES = ['Ash', 'Black', 'Bright', 'Cold', 'Dun', 'East', 'Ember', 'Fen', 'Frost', 'Glass', 'Gold', 'Harrow', 'High', 'Iron', 'North', 'Oak', 'Pine', 'Raven', 'Red', 'Salt', 'Silver', 'South', 'Stone', 'Storm', 'Thorn', 'Vale', 'West', 'Wolf', 'Elder', 'Moss'];
const SUFFIXES = ['ford', 'fen', 'water', 'holt', 'harbor', 'mark', 'more', 'mere', 'wick', 'wind', 'gate', 'moor', 'haven', 'crest', 'ton', 'cliff', 'marsh', 'bury', 'field', 'wood', 'reach', 'bridge', 'hollow', 'keep', 'watch', 'stead', 'port', 'dale'];

/** The hand-picked names first, then made-up ones from syllables: enough for any bot count. */
function botNames(count: number, rng: Rng): string[] {
  const names = shuffle([...BOT_NAMES], rng);
  const taken = new Set(names);
  const made: string[] = [];
  for (const a of PREFIXES) for (const b of SUFFIXES) if (!taken.has(a + b)) made.push(a + b);
  names.push(...shuffle(made, rng));
  return names.slice(0, Math.max(count, BOT_NAMES.length));
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Well-spread hues (golden angle), skipping any too close to the human's colour. */
function botColors(count: number, avoid: number | null, rng: Rng): number[] {
  const avoidHue = avoid === null ? null : hueOf(avoid);
  const colors: number[] = [];
  let hue = rng.next() * 360;
  for (let k = 0; colors.length < count; k++) {
    hue = (hue + 137.508) % 360;
    if (avoidHue !== null && k < count * 4) {
      const gap = Math.abs(hue - avoidHue);
      if (Math.min(gap, 360 - gap) < 24) continue;
    }
    const variant = colors.length % 3;
    const saturation = [0.62, 0.52, 0.7][variant];
    const lightness = [0.5, 0.6, 0.42][variant];
    colors.push(hslToRgb(hue, saturation, lightness));
  }
  return colors;
}

export function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g] = [c, x];
  else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x];
  else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  const m = l - c / 2;
  const to = (v: number) => Math.round((v + m) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

function hueOf(rgb: number): number {
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
