import { hash2 } from './rng';

export const Terrain = {
  Water: 0,
  Plains: 1,
  Highlands: 2,
  Mountains: 3,
} as const;

export interface GameMap {
  readonly width: number;
  readonly height: number;
  /** One Terrain value per tile, row by row (index = y * width + x). */
  readonly terrain: Uint8Array;
  readonly landTiles: number;
}

export type MapSize = 'small' | 'medium' | 'large';

export const MAP_DIMENSIONS: Record<MapSize, { width: number; height: number }> = {
  small: { width: 320, height: 200 },
  medium: { width: 480, height: 300 },
  large: { width: 640, height: 400 },
};

const LAND_SHARE = 0.56;
/** Share of land that is highlands or higher, and mountains. */
const HIGHLANDS_FROM = 0.64;
const MOUNTAINS_FROM = 0.88;

export function mapFromTerrain(width: number, height: number, terrain: Uint8Array): GameMap {
  let landTiles = 0;
  for (let i = 0; i < terrain.length; i++) if (terrain[i] !== Terrain.Water) landTiles++;
  return { width, height, terrain, landTiles };
}

/**
 * Builds one connected continent from layered value noise. Land not joined
 * to the largest landmass is sunk, because nobody can cross water yet.
 */
export function generateMap(seed: number, width: number, height: number): GameMap {
  const size = width * height;
  const elevation = new Float64Array(size);
  const ridges = new Float64Array(size);
  const cell = Math.min(width, height) / 2.6;
  const margin = Math.min(width, height) * 0.16;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / cell;
      const ny = y / cell;
      // Warp the coordinates first so coastlines bend instead of following the grid.
      const wx = fbm(seed + 11, nx * 0.9, ny * 0.9, 3) - 0.5;
      const wy = fbm(seed + 23, nx * 0.9 + 5.2, ny * 0.9 + 1.3, 3) - 0.5;
      let e = fbm(seed, nx + wx * 1.2, ny + wy * 1.2, 6);
      // Sink the edges so the continent sits in open sea.
      const edge = Math.min(x, width - 1 - x, y, height - 1 - y) / margin;
      if (edge < 1) e -= (1 - edge * edge * (3 - 2 * edge)) * 0.35;
      const i = y * width + x;
      elevation[i] = e;
      ridges[i] = 1 - Math.abs(fbm(seed + 37, nx * 1.7, ny * 1.7, 4) * 2 - 1);
    }
  }

  const seaLevel = quantile(elevation, 1 - LAND_SHARE);
  const terrain = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (elevation[i] > seaLevel) terrain[i] = Terrain.Plains;
  keepLargestLandmass(terrain, width);

  // Rank land by height plus ridges, so every map gets the same terrain mix
  // and mountains form chains rather than blobs.
  const scores = new Float64Array(size);
  const landScores: number[] = [];
  for (let i = 0; i < size; i++) {
    if (terrain[i] === Terrain.Water) continue;
    const s = (elevation[i] - seaLevel) * 1.5 + ridges[i] * ridges[i] * 0.35;
    scores[i] = s;
    landScores.push(s);
  }
  const land = Float64Array.from(landScores);
  const highlands = quantile(land, HIGHLANDS_FROM);
  const mountains = quantile(land, MOUNTAINS_FROM);
  for (let i = 0; i < size; i++) {
    if (terrain[i] === Terrain.Water) continue;
    const s = scores[i];
    terrain[i] = s >= mountains ? Terrain.Mountains : s >= highlands ? Terrain.Highlands : Terrain.Plains;
  }

  return mapFromTerrain(width, height, terrain);
}

function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(seed, x0, y0);
  const n10 = hash2(seed, x0 + 1, y0);
  const n01 = hash2(seed, x0, y0 + 1);
  const n11 = hash2(seed, x0 + 1, y0 + 1);
  const top = n00 + (n10 - n00) * sx;
  const bottom = n01 + (n11 - n01) * sx;
  return top + (bottom - top) * sy;
}

/** Fractal noise in [0, 1): several octaves of value noise, each finer and fainter. */
function fbm(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(seed + o * 1013, x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function quantile(values: Float64Array, q: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function keepLargestLandmass(terrain: Uint8Array, width: number): void {
  const size = terrain.length;
  const label = new Int32Array(size).fill(-1);
  const stack = new Int32Array(size);
  let best = -1;
  let bestSize = 0;
  let count = 0;

  for (let start = 0; start < size; start++) {
    if (terrain[start] === Terrain.Water || label[start] >= 0) continue;
    const id = count++;
    let top = 0;
    let tiles = 0;
    stack[top++] = start;
    label[start] = id;
    while (top > 0) {
      const t = stack[--top];
      tiles++;
      const x = t % width;
      if (x > 0 && terrain[t - 1] !== Terrain.Water && label[t - 1] < 0) {
        label[t - 1] = id;
        stack[top++] = t - 1;
      }
      if (x < width - 1 && terrain[t + 1] !== Terrain.Water && label[t + 1] < 0) {
        label[t + 1] = id;
        stack[top++] = t + 1;
      }
      if (t >= width && terrain[t - width] !== Terrain.Water && label[t - width] < 0) {
        label[t - width] = id;
        stack[top++] = t - width;
      }
      if (t + width < size && terrain[t + width] !== Terrain.Water && label[t + width] < 0) {
        label[t + width] = id;
        stack[top++] = t + width;
      }
    }
    if (tiles > bestSize) {
      bestSize = tiles;
      best = id;
    }
  }

  for (let i = 0; i < size; i++) if (label[i] !== best) terrain[i] = Terrain.Water;
}
