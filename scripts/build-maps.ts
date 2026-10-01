/**
 * Rasterises Natural Earth coastlines (public domain, via the world-atlas
 * package) into the land masks behind the real-world maps, and writes them
 * to src/core/realmap-data.ts. Run again only to change regions or detail:
 *
 *   npx tsx scripts/build-maps.ts
 */
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://cdn.jsdelivr.net/npm/world-atlas@2';

interface Topology {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: Record<string, { type: string; geometries: Geometry[] }>;
}
interface Geometry {
  type: 'Polygon' | 'MultiPolygon';
  arcs: number[][] | number[][][];
  properties?: { name?: string };
}

/** A region of the globe, projected plate carrée with longitudes squeezed by cos(mid latitude). */
interface Region {
  id: string;
  lon: [number, number];
  lat: [number, number];
  /** Mask width in pixels; the height follows from the projection. */
  width: number;
  /** Only this country's outline counts as land (otherwise all land). */
  country?: string;
}

const REGIONS: Region[] = [
  { id: 'world', lon: [-180, 180], lat: [-56, 76], width: 2200 },
  { id: 'europe', lon: [-25, 48], lat: [33, 71.5], width: 1500 },
  { id: 'germany', lon: [5.6, 15.3], lat: [47.1, 55.2], width: 1100, country: 'Germany' },
];

/** Decodes TopoJSON arcs into absolute [lon, lat] rings. */
function rings(topo: Topology, geometries: Geometry[]): [number, number][][] {
  const { scale, translate } = topo.transform;
  const decoded = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]): [number, number] => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  const arcPoints = (i: number) => (i >= 0 ? decoded[i] : [...decoded[~i]].reverse());
  const ring = (ids: number[]) => ids.flatMap((i, k) => (k === 0 ? arcPoints(i) : arcPoints(i).slice(1)));
  const out: [number, number][][] = [];
  for (const g of geometries) {
    const polygons = (g.type === 'Polygon' ? [g.arcs] : g.arcs) as number[][][];
    for (const polygon of polygons) for (const r of polygon) out.push(ring(r));
  }
  return out;
}

/** Even-odd scanline fill of every ring into a width × height mask. */
function rasterise(region: Region, all: [number, number][][]): { mask: Uint8Array; height: number } {
  const [lon0, lon1] = region.lon;
  const [lat0, lat1] = region.lat;
  const squeeze = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const width = region.width;
  const height = Math.round((width * (lat1 - lat0)) / ((lon1 - lon0) * squeeze));
  const mask = new Uint8Array(width * height);
  const px = (lon: number) => ((lon - lon0) / (lon1 - lon0)) * width;
  const py = (lat: number) => ((lat1 - lat) / (lat1 - lat0)) * height;
  const crossings: number[][] = Array.from({ length: height }, () => []);
  // Rings crossing the antimeridian jump from +180 to -180: unwrap them into one continuous ring,
  // then fill it at its own place and shifted a full turn either way.
  const unwrapped: [number, number][][] = [];
  for (const ring of all) {
    const out: [number, number][] = [ring[0]];
    for (let i = 1; i < ring.length; i++) {
      let lon = ring[i][0];
      const prev = out[i - 1][0];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
      out.push([lon, ring[i][1]]);
    }
    // A ring that winds round the pole (Antarctica) doesn't close again: leave it out.
    if (Math.abs(out[out.length - 1][0] - out[0][0]) > 1) continue;
    for (const shift of [-360, 0, 360]) unwrapped.push(out.map(([lon, lat]): [number, number] => [lon + shift, lat]));
  }
  for (const r of unwrapped) {
    for (let i = 0; i < r.length - 1; i++) {
      const x0 = px(r[i][0]);
      const y0 = py(r[i][1]);
      const x1 = px(r[i + 1][0]);
      const y1 = py(r[i + 1][1]);
      if (y0 === y1) continue;
      const lo = Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5));
      const hi = Math.min(height - 1, Math.floor(Math.max(y0, y1) - 0.5));
      for (let row = lo; row <= hi; row++) {
        const yc = row + 0.5;
        if ((yc - y0) * (yc - y1) > 0) continue;
        crossings[row].push(x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
  }
  for (let row = 0; row < height; row++) {
    const xs = crossings[row].sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5));
      const b = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) mask[row * width + x] = 1;
    }
  }
  return { mask, height };
}

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Run lengths (water first, then alternating), each as a base-64 varint: 5 bits a digit, +32 to continue. */
function encode(mask: Uint8Array): string {
  let out = '';
  let value = 0;
  let run = 0;
  const put = (n: number) => {
    do {
      const bits = n & 31;
      n >>>= 5;
      out += DIGITS[bits | (n > 0 ? 32 : 0)];
    } while (n > 0);
  };
  for (const v of mask) {
    if (v === value) run++;
    else {
      put(run);
      value = v;
      run = 1;
    }
  }
  put(run);
  return out;
}

async function main(): Promise<void> {
  const land = (await (await fetch(`${SOURCE}/land-50m.json`)).json()) as Topology;
  const countries = (await (await fetch(`${SOURCE}/countries-50m.json`)).json()) as Topology;
  const lines = [
    '// Generated by scripts/build-maps.ts from Natural Earth (public domain) via world-atlas. Do not edit.',
    '',
    'export interface RealMask {',
    '  width: number;',
    '  height: number;',
    '  lon: [number, number];',
    '  lat: [number, number];',
    '  /** Run lengths, water first, as base-64 varints (see decodeMask). */',
    '  runs: string;',
    '}',
    '',
    'export const REAL_MASKS: Record<string, RealMask> = {',
  ];
  for (const region of REGIONS) {
    const shapes = region.country
      ? rings(countries, countries.objects.countries.geometries.filter((g) => g.properties?.name === region.country))
      : rings(land, land.objects.land.geometries);
    const { mask, height } = rasterise(region, shapes);
    const runs = encode(mask);
    const share = mask.reduce((n, v) => n + v, 0) / mask.length;
    console.log(`${region.id}: ${region.width}x${height}, ${(share * 100).toFixed(0)}% land, ${(runs.length / 1024).toFixed(1)} KB`);
    lines.push(`  ${region.id}: { width: ${region.width}, height: ${height}, lon: [${region.lon.join(', ')}], lat: [${region.lat.join(', ')}], runs: '${runs}' },`);
  }
  lines.push('};', '');
  writeFileSync(new URL('../src/core/realmap-data.ts', import.meta.url), lines.join('\n'));
}

void main();
