/** Achievements and lifetime stats, kept in this browser. */

export type AchievementId =
  | 'tutorial'
  | 'firstWin'
  | 'quickWin'
  | 'classicWin'
  | 'royaleWin'
  | 'teamWin'
  | 'worldWin'
  | 'hardWin'
  | 'fogWin'
  | 'daily'
  | 'capital'
  | 'nuke'
  | 'hbomb'
  | 'sinker'
  | 'tenCities'
  | 'half'
  | 'veteran';

export const ACHIEVEMENTS: { id: AchievementId; name: string; text: string }[] = [
  { id: 'tutorial', name: 'Musterschüler', text: 'Schließ das Tutorial ab.' },
  { id: 'firstWin', name: 'Erster Sieg', text: 'Gewinne eine Partie.' },
  { id: 'quickWin', name: 'Blitzsieg', text: 'Gewinne ein schnelles Spiel.' },
  { id: 'classicWin', name: 'Eroberer', text: 'Gewinne eine klassische Partie.' },
  { id: 'royaleWin', name: 'Trockene Füße', text: 'Gewinne Battle Royale.' },
  { id: 'teamWin', name: 'Teamplayer', text: 'Gewinne mit deinem Team.' },
  { id: 'worldWin', name: 'Weltherrschaft', text: 'Gewinne auf einer echten Karte.' },
  { id: 'hardWin', name: 'Gegen die Besten', text: 'Gewinne gegen schwere Bots.' },
  { id: 'fogWin', name: 'Durch den Nebel', text: 'Gewinne mit Nebel des Krieges.' },
  { id: 'daily', name: 'Tagesform', text: 'Gewinne eine tägliche Herausforderung.' },
  { id: 'capital', name: 'Königsmörder', text: 'Erobere eine feindliche Hauptstadt.' },
  { id: 'nuke', name: 'Atomzeitalter', text: 'Feuere eine Atombombe ab.' },
  { id: 'hbomb', name: 'Sonne auf Erden', text: 'Feuere eine H-Bombe ab.' },
  { id: 'sinker', name: 'Admiral', text: 'Versenke ein feindliches Kriegsschiff.' },
  { id: 'tenCities', name: 'Städtebauer', text: 'Besitze 10 Städte auf einmal.' },
  { id: 'half', name: 'Halbe Welt', text: 'Halte die Hälfte des Landes.' },
  { id: 'veteran', name: 'Veteran', text: 'Spiele 10 Partien zu Ende.' },
];

export interface Profile {
  played: number;
  won: number;
  /** Achievement id → date unlocked (YYYY-MM-DD). */
  unlocked: Partial<Record<AchievementId, string>>;
}

const KEY = 'landgrab.profile.v1';

export function loadProfile(): Profile {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Profile>;
    return {
      played: Number(saved.played) || 0,
      won: Number(saved.won) || 0,
      unlocked: saved.unlocked && typeof saved.unlocked === 'object' ? saved.unlocked : {},
    };
  } catch {
    return { played: 0, won: 0, unlocked: {} };
  }
}

function save(profile: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Storage blocked: progress lasts until the page closes.
  }
}

/** Listeners told about each new unlock (the HUD shows a note). */
const listeners: ((name: string) => void)[] = [];

export function onUnlock(listener: (name: string) => void): void {
  listeners.push(listener);
}

/** Unlocks an achievement; returns true the first time. */
export function unlock(id: AchievementId): boolean {
  const profile = loadProfile();
  if (profile.unlocked[id]) return false;
  profile.unlocked[id] = new Date().toISOString().slice(0, 10);
  save(profile);
  const name = ACHIEVEMENTS.find((a) => a.id === id)!.name;
  for (const l of listeners) l(name);
  return true;
}

export interface MatchSummary {
  won: boolean;
  mode: 'quick' | 'classic' | 'royale';
  teams: boolean;
  realMap: boolean;
  hard: boolean;
  fog: boolean;
  daily: boolean;
}

/** Counts a finished match and unlocks what it earned. */
export function recordMatch(m: MatchSummary): void {
  const profile = loadProfile();
  profile.played++;
  if (m.won) profile.won++;
  save(profile);
  if (profile.played >= 10) unlock('veteran');
  if (!m.won) return;
  unlock('firstWin');
  unlock(m.mode === 'quick' ? 'quickWin' : m.mode === 'royale' ? 'royaleWin' : 'classicWin');
  if (m.teams) unlock('teamWin');
  if (m.realMap) unlock('worldWin');
  if (m.hard) unlock('hardWin');
  if (m.fog) unlock('fogWin');
  if (m.daily) unlock('daily');
}
