/** Colours a player can pick in the menu. Bots get generated colours that avoid the pick. */
export const SWATCHES: { name: string; color: number }[] = [
  { name: 'Karmesin', color: 0xd7263d },
  { name: 'Mandarine', color: 0xf46036 },
  { name: 'Safran', color: 0xf2b134 },
  { name: 'Limette', color: 0x8cc63f },
  { name: 'Smaragd', color: 0x1b9e5a },
  { name: 'Petrol', color: 0x17a2a4 },
  { name: 'Azur', color: 0x2e86de },
  { name: 'Indigo', color: 0x4b4bc8 },
  { name: 'Violett', color: 0x8e44d8 },
  { name: 'Magenta', color: 0xd63384 },
  { name: 'Rosa', color: 0xff7aa2 },
  { name: 'Anthrazit', color: 0x3a4750 },
];

export function toHex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

export function fromHex(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) & 0xffffff;
}

export function mix(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Negative amounts darken towards black, positive ones lighten towards white. */
export function shade(rgb: number, amount: number): number {
  return amount < 0 ? mix(rgb, 0x000000, -amount) : mix(rgb, 0xffffff, amount);
}

/** Pixel value for a Uint32Array view over ImageData (little-endian RGBA). */
export function toPixel(rgb: number): number {
  return (0xff000000 | ((rgb & 255) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 255)) >>> 0;
}
