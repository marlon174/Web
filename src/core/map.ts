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
  /** 1 for tiles of the largest landmass, where everyone starts. Other land is islands. */
  readonly mainland: Uint8Array;
  /** Height of each land tile, 0–255, for hill shading. Water is 0. */
  readonly relief: Uint8Array;
}

export type MapSize = 'small' | 'medium' | 'large' | 'huge';

export const MAP_DIMENSIONS: Record<MapSize, { width: number; height: number }> = {
  small: { width: 480, height: 300 },
  medium: { width: 800, height: 500 },
  large: { width: 1200, height: 750 },
  huge: { width: 1600, height: 1000 },
};

const LAND_SHARE = 0.56;
/** Share of land that is highlands or higher, and mountains. */
const HIGHLANDS_FROM = 0.64;
const MOUNTAINS_FROM = 0.88;

/** Islands smaller than this are sunk: too small to be worth a boat. */
const MIN_ISLAND = 80;

export function mapFromTerrain(width: number, height: number, terrain: Uint8Array, relief?: Uint8Array): GameMap {
  let landTiles = 0;
  for (let i = 0; i < terrain.length; i++) if (terrain[i] !== Terrain.Water) landTiles++;
  const { label, sizes } = labelLandmasses(terrain, width);
  let largest = -1;
  sizes.forEach((n, id) => {
    if (largest < 0 || n > sizes[largest]) largest = id;
  });
  const mainland = new Uint8Array(terrain.length);
  for (let i = 0; i < terrain.length; i++) if (label[i] === largest && largest >= 0) mainland[i] = 1;
  if (!relief) {
    relief = new Uint8Array(terrain.length);
    for (let i = 0; i < terrain.length; i++) relief[i] = terrain[i] * 60;
  }
  return { width, height, terrain, landTiles, mainland, relief };
}

/**
 * Builds a continent plus islands from layered value noise. Everyone starts
 * on the continent; islands are reached by boat.
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
  sinkSmallIslands(terrain, width);

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

  // Relief for shading: height rank on land, smooth enough to light like hills.
  const relief = new Uint8Array(size);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < size; i++) {
    if (terrain[i] === Terrain.Water) continue;
    if (scores[i] < lo) lo = scores[i];
    if (scores[i] > hi) hi = scores[i];
  }
  for (let i = 0; i < size; i++) {
    if (terrain[i] !== Terrain.Water) relief[i] = 1 + Math.floor((254 * (scores[i] - lo)) / Math.max(1e-9, hi - lo));
  }
  return mapFromTerrain(width, height, terrain, relief);
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

/** Connected landmasses (4-neighbour): a label per tile (-1 for water) and each one's size. */
function labelLandmasses(terrain: Uint8Array, width: number): { label: Int32Array; sizes: number[] } {
  const size = terrain.length;
  const label = new Int32Array(size).fill(-1);
  const stack = new Int32Array(size);
  const sizes: number[] = [];
  for (let start = 0; start < size; start++) {
    if (terrain[start] === Terrain.Water || label[start] >= 0) continue;
    const id = sizes.length;
    let top = 0;
    let tiles = 0;
    stack[top++] = start;
    label[start] = id;
    while (top > 0) {
      const t = stack[--top];
      tiles++;
      const x = t % width;
      for (const n of [x > 0 ? t - 1 : -1, x < width - 1 ? t + 1 : -1, t - width, t + width]) {
        if (n >= 0 && n < size && terrain[n] !== Terrain.Water && label[n] < 0) {
          label[n] = id;
          stack[top++] = n;
        }
      }
    }
    sizes.push(tiles);
  }
  return { label, sizes };
}

function sinkSmallIslands(terrain: Uint8Array, width: number): void {
  const { label, sizes } = labelLandmasses(terrain, width);
  for (let i = 0; i < terrain.length; i++) if (label[i] >= 0 && sizes[label[i]] < MIN_ISLAND) terrain[i] = Terrain.Water;
}
