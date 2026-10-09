import { click, t } from './i18n';
/**
 * Tips for newcomers: each shows once, when it first applies, then never
 * again in this browser. Switching tips back on in the settings shows them anew.
 */
const KEY = 'landgrab.tips.seen.v1';

export type TipId = 'expand' | 'city' | 'full' | 'neighbour' | 'attacked' | 'zoom';

export const TIPS: Record<TipId, string> = {
  expand: t(`Tipp: ${click} auf freies Land neben dir, um dich auszubreiten. Der Regler „Senden“ unten legt fest, wie viele Truppen losziehen.`, `Tip: ${click.toLowerCase()} the empty land next to you to expand. The Send slider below sets how many troops go.`),
  zoom: t('Tipp: Ziehen verschiebt die Karte, Mausrad oder zwei Finger zoomen. Der Zielknopf oben (C) bringt dich zurück.', 'Tip: drag to move the map, scroll or pinch to zoom. The target button at the top (C) brings you back.'),
  city: t('Tipp: Du hast genug Gold für eine Stadt (Q). Städte erhöhen, wie viele Truppen du haben kannst.', 'Tip: you have enough gold for a city (Q). Cities raise how many troops you can hold.'),
  full: t('Tipp: Deine Truppen sind fast voll. Gib sie aus: Volle Truppen wachsen nicht weiter.', 'Tip: your troops are nearly full. Spend them: full troops stop growing.'),
  neighbour: t(`Tipp: ${click} auf das Land eines Nachbarn, um anzugreifen. Je mehr Truppen du schickst, desto schneller geht es.`, `Tip: ${click.toLowerCase()} a neighbour's land to attack. The more troops you send, the faster it goes.`),
  attacked: t('Tipp: Du wirst angegriffen! Ein Bunker (R) macht dein Land in seiner Nähe viel schwerer einnehmbar.', 'Tip: you\'re under attack! A bunker (R) makes your land around it much harder to take.'),
};

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function tipsEnabled(): boolean {
  return !document.documentElement.classList.contains('hide-tips');
}

/** True (and remembered) the first time a tip is due; false if seen or tips are off. */
export function takeTip(id: TipId): boolean {
  if (!tipsEnabled()) return false;
  const seen = load();
  if (seen.has(id)) return false;
  seen.add(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...seen]));
  } catch {
    // Can't remember it: it may show again next match, which is harmless.
  }
  return true;
}

export function resetTips(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to reset.
  }
}
