import { fbm, mapFromTerrain, sinkSmallIslands, Terrain, type GameMap } from './map';
import { REAL_MASKS, type RealMask } from './realmap-data';

export type RealMapId = 'world' | 'europe' | 'germany';
export const REAL_MAP_IDS: readonly RealMapId[] = ['world', 'europe', 'germany'];

/**
 * Mountain ranges as [lon, lat] lines, with their half-width in degrees of
 * latitude and how high they rise (1: snowy peaks along the crest, under
 * about 0.5: only hills). Plateaus are discs of high ground.
 */
const RANGES: { line: [number, number][]; width: number; peak: number }[] = [
  // Asia
  { line: [[72, 35.5], [76, 33.5], [80, 31], [84, 28.7], [88, 27.9], [92, 28], [95.5, 29]], width: 2.2, peak: 1 },
  { line: [[68.5, 34.5], [71.5, 36], [74.5, 36.6], [77.5, 35.5]], width: 1.6, peak: 1 },
  { line: [[69.5, 41.5], [75, 41.5], [80, 42], [86, 43], [90, 43.5]], width: 1.5, peak: 0.9 },
  { line: [[84, 50], [88, 49.5], [92, 48.5], [97, 47]], width: 1.6, peak: 0.75 },
  { line: [[79, 35.5], [86, 35.8], [93, 35], [99, 33.5]], width: 2.5, peak: 0.85 },
  { line: [[98, 31], [99.5, 27], [98, 23]], width: 1.4, peak: 0.75 },
  { line: [[59, 51], [59.5, 56], [60, 61], [61.5, 65], [65, 68]], width: 1, peak: 0.55 },
  { line: [[38.5, 44], [41, 43.3], [44, 42.7], [47.5, 41.3]], width: 0.8, peak: 0.95 },
  { line: [[44.5, 36.5], [47.5, 34], [51, 31], [54.5, 28.5], [57, 27]], width: 1.4, peak: 0.75 },
  { line: [[50, 36.5], [53, 36.3], [56, 37.3], [59, 37]], width: 0.9, peak: 0.7 },
  { line: [[29.5, 36.8], [33, 36.7], [36.5, 37.6], [40, 38.5], [43, 39.3]], width: 1.2, peak: 0.7 },
  { line: [[136, 35.2], [137.8, 36.3], [139.8, 38.5], [140.6, 41]], width: 0.7, peak: 0.7 },
  { line: [[105, 37], [104, 33], [103, 29]], width: 1.5, peak: 0.6 },
  { line: [[96, 50], [102, 48], [106, 46.5]], width: 2.5, peak: 0.5 },
  { line: [[128, 61], [136, 63], [145, 64], [155, 66]], width: 2, peak: 0.55 },
  // Europe
  { line: [[5.8, 44], [7, 45.6], [8.5, 46.3], [10.5, 46.5], [12.5, 47], [14.5, 47.2], [16, 47.5]], width: 0.7, peak: 1 },
  { line: [[-1.8, 43], [0.5, 42.7], [3, 42.5]], width: 0.45, peak: 0.85 },
  { line: [[18.5, 49.4], [21, 49.3], [24, 48.2], [25.5, 47], [26, 45.6], [24, 45.4], [22.5, 45.2]], width: 0.65, peak: 0.7 },
  { line: [[14.5, 45.5], [17, 44], [19.5, 42.5], [20.8, 41], [21.5, 39.5], [22, 38]], width: 0.7, peak: 0.6 },
  { line: [[8.8, 44.4], [11, 44], [13, 42.8], [14.5, 41.6], [16, 40.2], [16.2, 38.6]], width: 0.5, peak: 0.6 },
  { line: [[6.5, 59], [8, 61], [10, 62.5], [13, 65], [16, 67.5], [19, 69], [22, 70]], width: 1.2, peak: 0.75 },
  { line: [[-5, 40.6], [-3.5, 40.8], [-1.5, 41.2]], width: 0.5, peak: 0.6 },
  { line: [[-6, 43.1], [-4.5, 43.1], [-3, 43]], width: 0.4, peak: 0.6 },
  { line: [[-5.2, 56.8], [-4.2, 57.2], [-3.5, 57.4]], width: 0.5, peak: 0.55 },
  { line: [[2.5, 45], [3, 45.5]], width: 0.6, peak: 0.5 },
  { line: [[22.5, 42.5], [25, 42.7], [26.5, 42.5]], width: 0.5, peak: 0.55 },
  // Germany's uplands (small, so they only matter on the Germany map)
  { line: [[8.1, 47.7], [8.2, 48.3], [8.4, 48.8]], width: 0.25, peak: 0.55 },
  { line: [[10.4, 51.75], [10.8, 51.8]], width: 0.12, peak: 0.6 },
  { line: [[12.3, 50.4], [13.2, 50.6], [14, 50.85]], width: 0.15, peak: 0.55 },
  { line: [[12.6, 49.3], [13.3, 48.95], [13.8, 48.75]], width: 0.18, peak: 0.55 },
  { line: [[10.2, 50.9], [10.8, 50.6], [11.3, 50.4]], width: 0.15, peak: 0.45 },
  { line: [[6.3, 50.4], [7.2, 50.3], [8.2, 50.3]], width: 0.3, peak: 0.4 },
  { line: [[9.2, 47.4], [10.5, 47.4], [11.5, 47.55], [12.6, 47.6], [13, 47.5]], width: 0.18, peak: 0.95 },
  // Africa
  { line: [[-9.5, 30.5], [-6, 31.5], [-3, 32.8], [1, 34], [5, 35.3], [9, 35.8]], width: 0.9, peak: 0.8 },
  { line: [[36, 13], [38, 10], [39.5, 8], [40, 6]], width: 2.2, peak: 0.75 },
  { line: [[29.5, -1], [32, -3], [35, -3], [37.3, -3]], width: 1.6, peak: 0.6 },
  { line: [[27, -31.5], [28.8, -29.5], [30.5, -27]], width: 0.8, peak: 0.65 },
  { line: [[9, 4.5], [11, 6.5], [13, 7.5]], width: 0.9, peak: 0.5 },
  { line: [[17, 22], [19, 21], [21, 20]], width: 1.4, peak: 0.5 },
  // Americas
  { line: [[-153, 61.5], [-149, 63], [-144, 62], [-140, 61]], width: 1.3, peak: 0.95 },
  { line: [[-136, 60], [-128, 57], [-122, 53.5], [-117, 50], [-114, 47], [-111, 44], [-107, 40], [-106, 36]], width: 2.6, peak: 0.95 },
  { line: [[-121.5, 49], [-121.8, 45], [-121.3, 41], [-119.5, 38], [-118.3, 36]], width: 1, peak: 0.8 },
  { line: [[-111, 31], [-107.5, 27], [-104.5, 23.5], [-101.5, 20], [-98, 18.8], [-96, 17]], width: 1.6, peak: 0.7 },
  { line: [[-85, 34.5], [-82, 36.5], [-79.5, 38.5], [-77.5, 40.5], [-74.5, 42.5], [-72, 44]], width: 1.2, peak: 0.5 },
  { line: [[-73, 11], [-75, 7.5], [-77, 3.5], [-78.8, -1], [-78, -6], [-76, -10.5], [-73.5, -14], [-70, -16.5], [-68.2, -19], [-67.8, -23], [-68.8, -28], [-70, -32], [-70.5, -36], [-71.5, -41], [-72.5, -46], [-73.3, -50]], width: 1.9, peak: 1 },
  { line: [[-70, -15.5], [-67.5, -18], [-66.5, -21]], width: 2.6, peak: 0.6 },
  { line: [[-48, -16], [-44, -19], [-42.5, -21.5]], width: 2, peak: 0.45 },
  // Oceania and Greenland
  { line: [[145, -16], [147, -20], [149.5, -25], [151, -29.5], [149.5, -34], [147.5, -36.8]], width: 1.1, peak: 0.55 },
  { line: [[167.5, -45.5], [169.5, -44], [171.5, -42.8], [173.5, -41.6]], width: 0.6, peak: 0.95 },
  { line: [[-45, 64], [-42, 70], [-40, 75]], width: 6, peak: 0.6 },
  { line: [[139, -4], [143, -5.5], [146, -6.5]], width: 1, peak: 0.8 },
];

export function decodeMask(mask: RealMask): Uint8Array {
  const out = new Uint8Array(mask.width * mask.height);
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let pos = 0;
  let value = 0;
  let i = 0;
  while (i < mask.runs.length) {
    let run = 0;
    let shift = 0;
    for (;;) {
      const d = digits.indexOf(mask.runs[i++]);
      run |= (d & 31) << shift;
      shift += 5;
      if (d < 32) break;
    }
    if (value) out.fill(1, pos, pos + run);
    pos += run;
    value ^= 1;
  }
  return out;
}

/**
 * A real-world map with about `area` tiles: coastlines from the stored mask,
 * mountains along the real ranges (roughened by noise), hills here and there.
 */
export function buildRealMap(id: RealMapId, area: number, seed: number): GameMap {
  const mask = REAL_MASKS[id];
  const land = decodeMask(mask);
  // Mostly-sea regions get more tiles, so there's about as much land as on a generated map.
  let share = 0;
  for (const v of land) share += v;
  area *= Math.min(1.6, Math.max(1, 0.56 / (share / land.length)));
  const aspect = mask.width / mask.height;
  const width = Math.round(Math.sqrt(area * aspect));
  const height = Math.round(width / aspect);
  const size = width * height;
  const terrain = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    const my = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width));
      if (land[my * mask.width + mx]) terrain[y * width + x] = Terrain.Plains;
    }
  }
  sinkSmallIslands(terrain, width);

  // Height from the ranges: a cone along each crest line, highest wins.
  const [lon0, lon1] = mask.lon;
  const [lat0, lat1] = mask.lat;
  const perDegree = height / (lat1 - lat0);
  const toX = (lon: number) => ((lon - lon0) / (lon1 - lon0)) * width;
  const toY = (lat: number) => ((lat1 - lat) / (lat1 - lat0)) * height;
  const lift = new Float32Array(size);
  // A noise field that widens and narrows each range, so they read as rugged country, not tubes.
  const scale = Math.max(8, width / 60);
  const rough = new Float32Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (terrain[i] !== Terrain.Water) rough[i] = fbm(seed + 3, x / scale, y / scale, 4);
    }
  }
  // On coarse maps (the whole world) ranges would be a few tiles thin: give them more body.
  const widen = Math.min(1.5, Math.max(1, 6 / perDegree));
  for (const range of RANGES) {
    const r = range.width * perDegree * widen;
    if (r < 1.5) continue;
    for (let k = 0; k + 1 < range.line.length; k++) {
      const ax = toX(range.line[k][0]);
      const ay = toY(range.line[k][1]);
      const bx = toX(range.line[k + 1][0]);
      const by = toY(range.line[k + 1][1]);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
      const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
      const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
          const ex = x - (ax + t * dx);
          const ey = y - (ay + t * dy);
          const i = y * width + x;
          const reach = r * (0.55 + 0.9 * rough[i]);
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d >= reach) continue;
          const v = range.peak * (1 - d / reach);
          if (v > lift[i]) lift[i] = v;
        }
      }
    }
  }

  // Roughen it, sprinkle a few hills elsewhere, and grade it into terrain classes.
  const relief = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (terrain[i] === Terrain.Water) continue;
      const n = rough[i];
      const hills = Math.max(0, fbm(seed + 9, x / (scale * 3), y / (scale * 3), 3) - 0.64) * 1.6;
      const v = Math.max(lift[i] * (0.8 + 0.4 * n), hills);
      let h: number;
      if (v > 0.55) {
        terrain[i] = Terrain.Mountains;
        h = 0.88 + 0.12 * Math.min(1, (v - 0.55) / 0.4);
      } else if (v > 0.22) {
        terrain[i] = Terrain.Highlands;
        h = 0.64 + 0.24 * ((v - 0.22) / 0.33);
      } else {
        h = 0.08 + 0.52 * Math.min(1, v / 0.22 * 0.6 + n * 0.4);
      }
      relief[i] = 1 + Math.floor(254 * Math.min(1, h));
    }
  }
  // Every continent counts as a starting landmass, not just the biggest.
  return mapFromTerrain(width, height, terrain, relief, 0.03);
}
