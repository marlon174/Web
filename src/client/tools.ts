import type { BuildingKind, MissileKind } from '../core/game';
import { t } from './i18n';

export type ToolKind = BuildingKind | MissileKind | 'ally' | 'warship';

/** Tools sit in groups on the bar: build the economy, defend, strike, talk. */
export type ToolGroup = 'economy' | 'defense' | 'strike' | 'diplomacy';

export const GROUP_NAMES: Record<ToolGroup, string> = {
  economy: t('Wirtschaft', 'Economy'),
  defense: t('Verteidigung', 'Defence'),
  strike: t('Raketen', 'Missiles'),
  diplomacy: t('Diplomatie', 'Diplomacy'),
};

export interface Tool {
  group: ToolGroup;
  kind: ToolKind;
  action: 'build' | 'launch' | 'ally' | 'warship';
  key: string;
  name: string;
  hint: string;
}

/** The build bar, in order and in groups. */
export const TOOLS: Tool[] = [
  { group: 'economy', kind: 'city', action: 'build', key: 'q', name: t('Stadt', 'City'), hint: t('Erhöht deine Truppenobergrenze um 20 % (höchstens +100 % mit 5 Städten; weitere zahlen sich über Züge aus). Du kannst 2 plus 1 je 2.500 Felder bauen.', 'Raises your troop cap by 20% (up to +100% with 5 cities; more pay off through trains). You can build 2, plus 1 per 2,500 tiles.') },
  { group: 'economy', kind: 'factory', action: 'build', key: 'w', name: t('Fabrik', 'Factory'), hint: t('Verlegt Gleise zu deinen Städten und Häfen in der Nähe. Jede Minute fährt ein Zug; jede Stadt und jeder Hafen auf der Strecke bringt 10K Gold.', 'Lays rail to your cities and ports nearby. A train runs every minute; each city and port on the line pays 10K gold.') },
  { group: 'economy', kind: 'port', action: 'build', key: 'e', name: t('Hafen', 'Port'), hint: t('An der Küste. Damit schickst du Truppen per Boot übers Wasser: einfach auf Land jenseits des Wassers klicken.', 'On the coast. Lets you ship troops across the water: just click land on the far side.') },
  { group: 'defense', kind: 'defense', action: 'build', key: 'r', name: 'Bunker', hint: t('Im großen Umkreis kostet dein Land Angreifer 3,5-mal so viel, fällt viel langsamer, und du verlierst dort nur halb so viele Truppen. Wird sein Feld erobert, ist er zerstört.', 'In a wide radius your land costs attackers 3.5 times as much, falls much more slowly, and you lose only half as many troops there. Destroyed if its tile is taken.') },
  { group: 'defense', kind: 'warship', action: 'warship', key: 'v', name: t('Schiff', 'Ship'), hint: t('Kriegsschiff: Klick aufs Wasser, und es läuft aus deinem nächsten Hafen dorthin aus. Es versenkt feindliche Boote und Schiffe und beschießt feindliche Küsten. Eins pro Hafen; danach lenkst du damit dein nächstes Schiff um.', 'Warship: click the water and one sails there from your nearest port. It sinks enemy boats and ships and shells enemy coasts. One per port; after that the tool steers your nearest ship.') },
  { group: 'defense', kind: 'silo', action: 'build', key: 't', name: 'Silo', hint: t('Nötig, um Raketen und Atombomben abzufeuern.', 'Needed to fire rockets and nukes.') },
  { group: 'strike', kind: 'rocket', action: 'launch', key: 'f', name: t('Rakete', 'Rocket'), hint: t('Zerstört Land und Gebäude in einem kleinen Umkreis.', 'Destroys land and buildings in a small radius.') },
  { group: 'strike', kind: 'nuke', action: 'launch', key: 'g', name: t('A-Bombe', 'Nuke'), hint: t('Zerstört einen großen Umkreis und verseucht ihn 30 Sekunden lang.', 'Destroys a wide radius and poisons it for 30 seconds.') },
  { group: 'strike', kind: 'hbomb', action: 'launch', key: 'b', name: t('H-Bombe', 'H-bomb'), hint: t('Wasserstoffbombe: fast doppelter Radius der Atombombe. Teuer, und du brauchst 3 Silos.', 'Hydrogen bomb: nearly twice a nuke\'s radius. Expensive, and you need 3 silos.') },
  { group: 'diplomacy', kind: 'ally', action: 'ally', key: 'h', name: t('Bündnis', 'Alliance'), hint: t('Klick auf das Land eines Spielers, um ein Bündnis für 3 Minuten anzubieten. Bei einem Verbündeten beendest du es damit.', 'Click a player\'s land to offer a 3-minute alliance. Used on an ally, it ends the alliance.') },
];

export function isMissile(kind: ToolKind): kind is MissileKind {
  return kind === 'rocket' || kind === 'nuke' || kind === 'hbomb';
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
  warship: 'M1 10h14l-2.2 3.5H3.2zM4 9V6.5h4V9zm5 0V7.5h3.5V9zM5 6V4h2v2zm4.5.8V5h4.8v1.2H11v.6z',
  ally: 'M1 7l3-3 3 1.5L9 4l3 .5 3 3-2 2-4.5 4.5a1.2 1.2 0 0 1-1.7-1.7l-.3.3a1.2 1.2 0 0 1-1.7-1.7l-.3.3a1.2 1.2 0 0 1-1.7-1.7l-.3.3A1.2 1.2 0 0 1 1.8 10.3z',
  defense: 'M8 1l6 2.4v4.4c0 3.6-2.5 6.1-6 7.2-3.5-1.1-6-3.6-6-7.2V3.4z',
  silo: 'M2 15h12v-2H2zM8 1c1.7 1.7 2.5 3.9 2.5 6.4V12h-5V7.4C5.5 4.9 6.3 2.7 8 1z',
  rocket: 'M8 1c1.8 1.8 2.6 4 2.6 6.6V10l2 3.5H3.4l2-3.5V7.6C5.4 5 6.2 2.8 8 1zM6.6 14h2.8L8 15.6z',
  nuke: trefoil(),
  hbomb: 'M8 1.5c3.6 0 6 2 6 4.6 0 2-1.7 3.3-3.6 3.7V12h1.3v1.6H4.3V12h1.3V9.8C3.7 9.4 2 8.1 2 6.1 2 3.5 4.4 1.5 8 1.5zM6.4 5.2a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm3.2 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5 14.4h6V15H5z',
};

export function iconSvg(kind: ToolKind): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[kind]}" fill="currentColor" fill-rule="evenodd"/></svg>`;
}
