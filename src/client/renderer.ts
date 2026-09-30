import { CONFIG } from '../core/config';
import { NEUTRAL, type Game } from '../core/game';
import { Terrain } from '../core/map';
import type { Camera } from './camera';
import { mix, shade, toHex, toPixel } from './colors';
import { formatTroops } from './format';
import { LabelLayout } from './labels';

/** Unclaimed land, by terrain: pale chart buff, darker with height. */
const LAND = [0, 0xe8dec3, 0xd5c6a0, 0xb3a58b];
/** Depth bands, like soundings on a nautical chart: [max tiles from shore, colour]. */
const DEPTHS: [number, number][] = [
  [2, 0x33698a],
  [4, 0x295c7c],
  [7, 0x22516f],
  [12, 0x1c4763],
];
export const OPEN_SEA = 0x173d57;

const NAME_FONT = '"Big Shoulders Display", "Arial Narrow", sans-serif';
const NUMBER_FONT = '"Public Sans", system-ui, sans-serif';

export interface Overlay {
  /** Tile under the mouse, or -1. */
  hover: number;
  /** While choosing a start: preview colour for the spawn area, else null. */
  spawnColor: number | null;
  spawnValid: boolean;
}

/**
 * Draws the map. Every tile is one pixel of an offscreen image that is
 * scaled up by the camera; only tiles that changed are repainted.
 */
export class Renderer {
  readonly labels: LabelLayout;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly surface: HTMLCanvasElement;
  private readonly surfaceCtx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  /** Pixel for each tile when nobody owns it. */
  private readonly base: Uint32Array;
  /** Territory pixels by player id × 4 + terrain. */
  private readonly fills: Uint32Array;
  private readonly borders: Uint32Array;
  private readonly capitalInk: string[];
  private dirty = { x0: 0, y0: 0, x1: -1, y1: -1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly game: Game,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser cannot draw 2D canvas graphics.');
    this.ctx = ctx;
    this.surface = document.createElement('canvas');
    this.surface.width = game.width;
    this.surface.height = game.height;
    this.surfaceCtx = this.surface.getContext('2d')!;
    this.image = this.surfaceCtx.createImageData(game.width, game.height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.base = this.paintBase();

    const slots = game.players.length + 1;
    this.fills = new Uint32Array(slots * 4);
    this.borders = new Uint32Array(slots);
    this.capitalInk = new Array<string>(slots).fill('#000');
    for (const p of game.players) {
      for (let t = 1; t <= 3; t++) this.fills[p.id * 4 + t] = toPixel(mix(p.color, LAND[t], 0.18));
      this.borders[p.id] = toPixel(shade(p.color, -0.38));
      this.capitalInk[p.id] = toHex(shade(p.color, -0.2));
    }
    this.labels = new LabelLayout(game);
    this.repaintAll();
  }

  repaintAll(): void {
    for (let i = 0; i < this.game.size; i++) this.paint(i);
    this.dirty = { x0: 0, y0: 0, x1: this.game.width - 1, y1: this.game.height - 1 };
  }

  /** Repaints tiles that changed owner, plus their neighbours' borders. */
  applyChanges(tiles: number[]): void {
    const { width: w, size } = this.game;
    const d = this.dirty;
    for (const t of tiles) {
      const x = t % w;
      const y = (t - x) / w;
      this.paint(t);
      if (x > 0) this.paint(t - 1);
      if (x < w - 1) this.paint(t + 1);
      if (t >= w) this.paint(t - w);
      if (t + w < size) this.paint(t + w);
      if (d.x1 < 0) {
        d.x0 = d.x1 = x;
        d.y0 = d.y1 = y;
      }
      d.x0 = Math.min(d.x0, x - 1);
      d.y0 = Math.min(d.y0, y - 1);
      d.x1 = Math.max(d.x1, x + 1);
      d.y1 = Math.max(d.y1, y + 1);
    }
  }

  render(camera: Camera, overlay: Overlay): void {
    const { ctx, canvas, game } = this;
    const d = this.dirty;
    if (d.x1 >= 0) {
      const x0 = Math.max(0, d.x0);
      const y0 = Math.max(0, d.y0);
      const x1 = Math.min(game.width - 1, d.x1);
      const y1 = Math.min(game.height - 1, d.y1);
      this.surfaceCtx.putImageData(this.image, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      d.x1 = -1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = toHex(OPEN_SEA);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = camera.scale < 1;
    ctx.setTransform(camera.scale, 0, 0, camera.scale, camera.x, camera.y);
    ctx.drawImage(this.surface, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    this.drawCapitals(camera, dpr);
    this.drawLabels(camera, dpr);
    this.drawSpawnPreview(camera, overlay, dpr);
  }

  private paint(i: number): void {
    const { owner, width: w, size } = this.game;
    const o = owner[i];
    if (o === NEUTRAL) {
      this.pixels[i] = this.base[i];
      return;
    }
    const x = i % w;
    const edge =
      (x > 0 && owner[i - 1] !== o) ||
      (x < w - 1 && owner[i + 1] !== o) ||
      (i >= w && owner[i - w] !== o) ||
      (i + w < size && owner[i + w] !== o);
    this.pixels[i] = edge ? this.borders[o] : this.fills[o * 4 + this.game.map.terrain[i]];
  }

  /** Terrain colours, with sea shaded in depth bands and a darker shoreline. */
  private paintBase(): Uint32Array {
    const { width: w, size } = this.game;
    const terrain = this.game.map.terrain;
    const depth = new Uint8Array(size).fill(255);
    const queue = new Int32Array(size);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < size; i++) {
      if (terrain[i] !== Terrain.Water) {
        depth[i] = 0;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const t = queue[head++];
      const next = depth[t] + 1;
      if (next > 12) continue;
      const x = t % w;
      for (const n of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, t - w, t + w]) {
        if (n >= 0 && n < size && depth[n] === 255) {
          depth[n] = next;
          queue[tail++] = n;
        }
      }
    }

    const base = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const t = terrain[i];
      if (t === Terrain.Water) {
        const band = DEPTHS.find(([max]) => depth[i] <= max);
        base[i] = toPixel(band ? band[1] : OPEN_SEA);
      } else {
        const x = i % w;
        const shore =
          (x > 0 && terrain[i - 1] === Terrain.Water) ||
          (x < w - 1 && terrain[i + 1] === Terrain.Water) ||
          (i >= w && terrain[i - w] === Terrain.Water) ||
          (i + w < size && terrain[i + w] === Terrain.Water);
        base[i] = toPixel(shore ? shade(LAND[t], -0.14) : LAND[t]);
      }
    }
    return base;
  }

  private drawLabels(camera: Camera, dpr: number): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const [id, label] of this.labels.labels) {
      const p = this.game.player(id);
      // Fit the name across the widest open circle in the territory, whatever font loaded.
      ctx.font = `800 100px ${NAME_FONT}`;
      const widthAt100 = Math.max(1, ctx.measureText(p.name).width);
      const size = Math.min(label.radius * 0.75, (170 * label.radius) / widthAt100);
      const px = size * camera.scale;
      if (px < 9 * dpr) continue;
      const sx = camera.x + label.x * camera.scale;
      const sy = camera.y + label.y * camera.scale;
      const numberPx = px * 0.62;
      const nameY = sy - numberPx * 0.45;
      const numberY = sy + px * 0.55;
      if (sx < -px * 8 || sy < -px * 2 || sx > this.canvas.width + px * 8 || sy > this.canvas.height + px * 2) continue;

      ctx.font = `800 ${px.toFixed(1)}px ${NAME_FONT}`;
      ctx.lineWidth = Math.max(2, px * 0.16);
      ctx.strokeStyle = 'rgba(8, 18, 26, 0.55)';
      ctx.strokeText(p.name, sx, nameY);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.name, sx, nameY);

      ctx.font = `700 ${numberPx.toFixed(1)}px ${NUMBER_FONT}`;
      ctx.lineWidth = Math.max(2, numberPx * 0.18);
      const troops = formatTroops(p.troops);
      ctx.strokeText(troops, sx, numberY);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
      ctx.fillText(troops, sx, numberY);
    }
  }

  /** A star in a ring: the map symbol for a capital. */
  private drawCapitals(camera: Camera, dpr: number): void {
    const { ctx, game } = this;
    const r = Math.min(10 * dpr, Math.max(4.5 * dpr, camera.scale * 1.5));
    for (const p of game.players) {
      if (!p.alive || p.capital < 0) continue;
      const x = p.capital % game.width;
      const y = (p.capital - x) / game.width;
      const sx = camera.x + (x + 0.5) * camera.scale;
      const sy = camera.y + (y + 0.5) * camera.scale;
      if (sx < -r || sy < -r || sx > this.canvas.width + r || sy > this.canvas.height + r) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = 'rgba(8, 18, 26, 0.7)';
      ctx.stroke();
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const angle = -Math.PI / 2 + (k * Math.PI) / 5;
        const radius = k % 2 === 0 ? r * 0.72 : r * 0.3;
        const px = sx + Math.cos(angle) * radius;
        const py = sy + Math.sin(angle) * radius;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = this.capitalInk[p.id];
      ctx.fill();
    }
  }

  private drawSpawnPreview(camera: Camera, overlay: Overlay, dpr: number): void {
    if (overlay.spawnColor === null || overlay.hover < 0) return;
    const { ctx, game } = this;
    const x = overlay.hover % game.width;
    const y = (overlay.hover - x) / game.width;
    const sx = camera.x + (x + 0.5) * camera.scale;
    const sy = camera.y + (y + 0.5) * camera.scale;
    const r = Math.max(8 * dpr, (CONFIG.spawnRadius + 0.5) * camera.scale);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    if (overlay.spawnValid) {
      ctx.fillStyle = toHex(overlay.spawnColor) + '99';
      ctx.fill();
    }
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = overlay.spawnValid ? '#ffffff' : '#ff7d7d';
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
