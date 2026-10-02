/** Achievements and lifetime stats, kept in this browser. */
import { t } from './i18n';

export type AchievementId =
  | 'tutorial'
  | 'firstWin'
  | 'quickWin'
  | 'classicWin'
  | 'royaleWin'
  | 'conquestWin'
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
  { id: 'tutorial', name: t('Musterschüler', 'Star pupil'), text: t('Schließ das Tutorial ab.', 'Finish the tutorial.') },
  { id: 'firstWin', name: t('Erster Sieg', 'First win'), text: t('Gewinne eine Partie.', 'Win a match.') },
  { id: 'quickWin', name: t('Blitzsieg', 'Blitz'), text: t('Gewinne ein schnelles Spiel.', 'Win a quick match.') },
  { id: 'classicWin', name: t('Eroberer', 'Conqueror'), text: t('Gewinne eine klassische Partie.', 'Win a classic match.') },
  { id: 'royaleWin', name: t('Trockene Füße', 'Dry feet'), text: t('Gewinne Battle Royale.', 'Win battle royale.') },
  { id: 'conquestWin', name: t('Alleinherrscher', 'Sole ruler'), text: t('Gewinne eine totale Eroberung.', 'Win a total conquest.') },
  { id: 'teamWin', name: t('Teamplayer', 'Team player'), text: t('Gewinne mit deinem Team.', 'Win with your team.') },
  { id: 'worldWin', name: t('Weltherrschaft', 'World domination'), text: t('Gewinne auf einer echten Karte.', 'Win on a real map.') },
  { id: 'hardWin', name: t('Gegen die Besten', 'Against the best'), text: t('Gewinne gegen schwere Bots.', 'Win against hard bots.') },
  { id: 'fogWin', name: t('Durch den Nebel', 'Through the fog'), text: t('Gewinne mit Nebel des Krieges.', 'Win with fog of war.') },
  { id: 'daily', name: t('Tagesform', 'On the day'), text: t('Gewinne eine tägliche Herausforderung.', 'Win a daily challenge.') },
  { id: 'capital', name: t('Königsmörder', 'Kingslayer'), text: t('Erobere eine feindliche Hauptstadt.', 'Take an enemy capital.') },
  { id: 'nuke', name: t('Atomzeitalter', 'Atomic age'), text: t('Feuere eine Atombombe ab.', 'Fire a nuke.') },
  { id: 'hbomb', name: t('Sonne auf Erden', 'Sun on earth'), text: t('Feuere eine H-Bombe ab.', 'Fire a hydrogen bomb.') },
  { id: 'sinker', name: t('Admiral', 'Admiral'), text: t('Versenke ein feindliches Kriegsschiff.', 'Sink an enemy warship.') },
  { id: 'tenCities', name: t('Städtebauer', 'City builder'), text: t('Besitze 10 Städte auf einmal.', 'Own 10 cities at once.') },
  { id: 'half', name: t('Halbe Welt', 'Half the world'), text: t('Halte die Hälfte des Landes.', 'Hold half the land.') },
  { id: 'veteran', name: t('Veteran', 'Veteran'), text: t('Spiele 10 Partien zu Ende.', 'Finish 10 matches.') },
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
  mode: 'quick' | 'classic' | 'royale' | 'conquest';
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
  unlock({ quick: 'quickWin', classic: 'classicWin', royale: 'royaleWin', conquest: 'conquestWin' }[m.mode] as AchievementId);
  if (m.teams) unlock('teamWin');
  if (m.realMap) unlock('worldWin');
  if (m.hard) unlock('hardWin');
  if (m.fog) unlock('fogWin');
  if (m.daily) unlock('daily');
}
