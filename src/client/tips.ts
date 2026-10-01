/**
 * Tips for newcomers: each shows once, when it first applies, then never
 * again in this browser. Switching tips back on in the settings shows them anew.
 */
const KEY = 'landgrab.tips.seen.v1';

export type TipId = 'expand' | 'city' | 'full' | 'neighbour' | 'attacked' | 'zoom';

export const TIPS: Record<TipId, string> = {
  expand: 'Tipp: Klick auf freies Land neben dir, um dich auszubreiten. Der Regler „Senden“ unten legt fest, wie viele Truppen losziehen.',
  zoom: 'Tipp: Ziehen verschiebt die Karte, Mausrad oder zwei Finger zoomen. Der Zielknopf oben (C) bringt dich zurück.',
  city: 'Tipp: Du hast genug Gold für eine Stadt (Q). Städte erhöhen, wie viele Truppen du haben kannst.',
  full: 'Tipp: Deine Truppen sind fast voll. Gib sie aus: Volle Truppen wachsen nicht weiter.',
  neighbour: 'Tipp: Klick auf das Land eines Nachbarn, um anzugreifen. Je mehr Truppen du schickst, desto schneller geht es.',
  attacked: 'Tipp: Du wirst angegriffen! Ein Bunker (R) macht dein Land in seiner Nähe viel schwerer einnehmbar.',
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
