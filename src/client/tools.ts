import type { BuildingKind, MissileKind } from '../core/game';

export type ToolKind = BuildingKind | MissileKind | 'ally';

export interface Tool {
  kind: ToolKind;
  action: 'build' | 'launch' | 'ally';
  key: string;
  name: string;
  hint: string;
}

/** The build bar, in order. Keys sit in one row on the keyboard. */
export const TOOLS: Tool[] = [
  { kind: 'city', action: 'build', key: 'q', name: 'Stadt', hint: 'Erhöht deine Truppenobergrenze um 20 %.' },
  { kind: 'factory', action: 'build', key: 'w', name: 'Fabrik', hint: 'Verlegt Gleise zu deinen Städten und Häfen in der Nähe. Jede Minute fährt ein Zug; jede Stadt und jeder Hafen auf der Strecke bringt 10K Gold.' },
  { kind: 'port', action: 'build', key: 'e', name: 'Hafen', hint: 'An der Küste. Damit schickst du Truppen per Boot übers Wasser: einfach auf Land jenseits des Wassers klicken.' },
  { kind: 'defense', action: 'build', key: 'r', name: 'Bunker', hint: 'Im großen Umkreis kostet dein Land Angreifer 3,5-mal so viel, fällt viel langsamer, und du verlierst dort nur halb so viele Truppen.' },
  { kind: 'silo', action: 'build', key: 't', name: 'Silo', hint: 'Nötig, um Raketen und Atombomben abzufeuern.' },
  { kind: 'rocket', action: 'launch', key: 'f', name: 'Rakete', hint: 'Zerstört Land und Gebäude in einem kleinen Umkreis.' },
  { kind: 'nuke', action: 'launch', key: 'g', name: 'Atombombe', hint: 'Zerstört einen großen Umkreis und verseucht ihn 30 Sekunden lang.' },
  { kind: 'ally', action: 'ally', key: 'h', name: 'Bündnis', hint: 'Klick auf das Land eines Spielers, um ein Bündnis für 3 Minuten anzubieten. Bei einem Verbündeten beendest du es damit.' },
];

export function isMissile(kind: ToolKind): kind is MissileKind {
  return kind === 'rocket' || kind === 'nuke';
}

/** Radiation trefoil: three blades around a dot. */
function trefoil(): string {
  const point = (r: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`;
  };
  let d = 'M9.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0z';
  for (const mid of [-90, 30, 150]) {
    d += `M${point(7, mid - 30)}A7 7 0 0 1 ${point(7, mid + 30)}L${point(2.4, mid + 30)}A2.4 2.4 0 0 0 ${point(2.4, mid - 30)}z`;
  }
  return d;
}

/** 16×16 SVG path data, shared by the build bar (SVG) and the map (canvas Path2D). */
export const ICONS: Record<ToolKind, string> = {
  city: 'M1 15V8h3V5h3v4h1V2h4v5h3v8z',
  port: 'M7.2 1h1.6v2.2h2.6v1.6H8.8V12c2 0 3.6-1 4.3-2.6L11.5 9H15c0 3.3-3 6-7 6s-7-2.7-7-6h3.5l-1.6.4C3.6 11 5.2 12 7.2 12V4.8H4.6V3.2h2.6z',
  factory: 'M1 15V6l4 2.5V6l4 2.5V6l4 2.5V2h2v13z',
  ally: 'M1 7l3-3 3 1.5L9 4l3 .5 3 3-2 2-4.5 4.5a1.2 1.2 0 0 1-1.7-1.7l-.3.3a1.2 1.2 0 0 1-1.7-1.7l-.3.3a1.2 1.2 0 0 1-1.7-1.7l-.3.3A1.2 1.2 0 0 1 1.8 10.3z',
  defense: 'M8 1l6 2.4v4.4c0 3.6-2.5 6.1-6 7.2-3.5-1.1-6-3.6-6-7.2V3.4z',
  silo: 'M2 15h12v-2H2zM8 1c1.7 1.7 2.5 3.9 2.5 6.4V12h-5V7.4C5.5 4.9 6.3 2.7 8 1z',
  rocket: 'M8 1c1.8 1.8 2.6 4 2.6 6.6V10l2 3.5H3.4l2-3.5V7.6C5.4 5 6.2 2.8 8 1zM6.6 14h2.8L8 15.6z',
  nuke: trefoil(),
};

export function iconSvg(kind: ToolKind): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[kind]}" fill="currentColor" fill-rule="evenodd"/></svg>`;
}
