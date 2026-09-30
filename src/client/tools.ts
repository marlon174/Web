import type { BuildingKind, MissileKind } from '../core/game';

export type ToolKind = BuildingKind | MissileKind;

export interface Tool {
  kind: ToolKind;
  action: 'build' | 'launch';
  key: string;
  name: string;
  hint: string;
}

/** The build bar, in order. Keys sit in one row on the keyboard. */
export const TOOLS: Tool[] = [
  { kind: 'city', action: 'build', key: 'q', name: 'City', hint: 'Raises your troop cap by 20%. Each one costs more than the last.' },
  { kind: 'defense', action: 'build', key: 'w', name: 'Defence', hint: 'Land around it costs attackers twice as much and falls slower.' },
  { kind: 'silo', action: 'build', key: 'e', name: 'Silo', hint: 'Needed to fire rockets and nukes.' },
  { kind: 'rocket', action: 'launch', key: 'r', name: 'Rocket', hint: 'Wipes out land and buildings in a small area.' },
  { kind: 'nuke', action: 'launch', key: 't', name: 'Nuke', hint: 'Wipes out a large area and poisons it for 30 seconds.' },
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
  defense: 'M8 1l6 2.4v4.4c0 3.6-2.5 6.1-6 7.2-3.5-1.1-6-3.6-6-7.2V3.4z',
  silo: 'M2 15h12v-2H2zM8 1c1.7 1.7 2.5 3.9 2.5 6.4V12h-5V7.4C5.5 4.9 6.3 2.7 8 1z',
  rocket: 'M8 1c1.8 1.8 2.6 4 2.6 6.6V10l2 3.5H3.4l2-3.5V7.6C5.4 5 6.2 2.8 8 1zM6.6 14h2.8L8 15.6z',
  nuke: trefoil(),
};

export function iconSvg(kind: ToolKind): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[kind]}" fill="currentColor" fill-rule="evenodd"/></svg>`;
}
