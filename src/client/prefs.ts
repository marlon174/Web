import type { Difficulty } from '../core/bots';
import type { MapSize } from '../core/map';
import type { RealMapId } from '../core/realmaps';
import type { Mode } from '../core/setup';
import { SWATCHES } from './colors';

/** Menu choices, remembered in this browser between visits. */
export interface Prefs {
  name: string;
  color: number;
  mode: Mode;
  mapSize: MapSize;
  bots: number;
  difficulty: Difficulty;
  /** Fog of war: see only near your own land. */
  fog: boolean;
  /** 0 for free-for-all, else the number of teams. */
  teams: number;
  /** A real-world map, or null for a generated one. */
  world: RealMapId | null;
}

const KEY = 'landgrab.prefs.v1';

const DEFAULTS: Prefs = {
  name: '',
  color: SWATCHES[0].color,
  mode: 'quick',
  mapSize: 'medium',
  bots: 15,
  difficulty: 'normal',
  fog: false,
  teams: 0,
  world: null,
};

export function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      name: typeof saved.name === 'string' ? saved.name.slice(0, 16) : DEFAULTS.name,
      color: typeof saved.color === 'number' ? saved.color & 0xffffff : DEFAULTS.color,
      mode: saved.mode === 'classic' || saved.mode === 'royale' ? saved.mode : 'quick',
      mapSize: saved.mapSize === 'small' || saved.mapSize === 'large' || saved.mapSize === 'huge' ? saved.mapSize : 'medium',
      bots: typeof saved.bots === 'number' ? Math.min(100, Math.max(3, Math.round(saved.bots))) : DEFAULTS.bots,
      difficulty: saved.difficulty === 'easy' || saved.difficulty === 'hard' ? saved.difficulty : 'normal',
      fog: saved.fog === true,
      teams: saved.teams === 2 || saved.teams === 4 ? saved.teams : 0,
      world: saved.world === 'world' || saved.world === 'europe' || saved.world === 'germany' ? saved.world : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private windows and blocked storage: the menu just won't remember.
  }
}
