import type { MatchOptions } from '../core/setup';
import { t } from './i18n';

/** One twist per weekday (0 = Sunday), so each day of the week plays differently. */
const TWISTS: { name: string; options: Partial<MatchOptions>; fog?: boolean }[] = [
  { name: 'Battle Royale', options: { mode: 'royale', mapSize: 'medium', bots: 15 } },
  { name: t('Klassisch', 'Classic'), options: { mode: 'classic', mapSize: 'medium', bots: 15 } },
  { name: t('Nebel des Krieges', 'Fog of war'), options: { mode: 'classic', mapSize: 'medium', bots: 15 }, fog: true },
  { name: t('2 Teams', '2 teams'), options: { mode: 'classic', mapSize: 'medium', bots: 15, teams: 2 } },
  { name: t('Schwere Bots', 'Hard bots'), options: { mode: 'classic', mapSize: 'medium', bots: 12, difficulty: 'hard' } },
  { name: t('Battle Royale mit Nebel', 'Battle royale in fog'), options: { mode: 'royale', mapSize: 'medium', bots: 15 }, fog: true },
  { name: t('Große Karte, 30 Bots', 'Big map, 30 bots'), options: { mode: 'classic', mapSize: 'large', bots: 30 } },
];

const WEEKDAYS = [t('Sonntag', 'Sunday'), t('Montag', 'Monday'), t('Dienstag', 'Tuesday'), t('Mittwoch', 'Wednesday'), t('Donnerstag', 'Thursday'), t('Freitag', 'Friday'), t('Samstag', 'Saturday')];
const KEY = 'landgrab.daily.v1';

export interface Daily {
  /** Local date, YYYY-MM-DD. */
  date: string;
  seed: number;
  title: string;
  options: Omit<MatchOptions, 'human'>;
  fog: boolean;
}

interface Record {
  date: string;
  /** Fastest win today in seconds, or 0. */
  best: number;
  tries: number;
}

/** Today's challenge: the same map, bots and twist for everyone on this date. */
export function today(now = new Date()): Daily {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let h = 2166136261;
  for (let i = 0; i < date.length; i++) h = Math.imul(h ^ date.charCodeAt(i), 16777619);
  const seed = 10000 + ((h >>> 0) % 90000);
  const twist = TWISTS[now.getDay()];
  return {
    date,
    seed,
    title: `${WEEKDAYS[now.getDay()]}: ${twist.name}`,
    options: { seed, mode: 'classic', mapSize: 'medium', bots: 15, difficulty: 'normal', teams: 0, ...twist.options },
    fog: twist.fog ?? false,
  };
}

function load(date: string): Record {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record>;
    if (saved.date === date) return { date, best: Number(saved.best) || 0, tries: Number(saved.tries) || 0 };
  } catch {
    // Unreadable storage: start the day fresh.
  }
  return { date, best: 0, tries: 0 };
}

/** Today's best time in seconds (0 if not won yet) and how many times it was played. */
export function progress(daily: Daily): { best: number; tries: number } {
  const r = load(daily.date);
  return { best: r.best, tries: r.tries };
}

/** Records a finished attempt; returns true when it is a new best time. */
export function recordResult(daily: Daily, won: boolean, seconds: number): boolean {
  const r = load(daily.date);
  r.tries++;
  const record = won && (r.best === 0 || seconds < r.best);
  if (record) r.best = Math.round(seconds);
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // Can't save: the result just isn't remembered.
  }
  return record;
}
