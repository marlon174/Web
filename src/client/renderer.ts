import { CONFIG } from '../core/config';
import { NEUTRAL, type Game, type Missile } from '../core/game';
import { Terrain } from '../core/map';
import type { Camera } from './camera';
import { mix, shade, toHex, toPixel } from './colors';
import { formatTroops } from './format';
import { LabelLayout } from './labels';
import { ICONS, isMissile, type ToolKind } from './tools';

/** Land colour by height (0–1): meadow, dry grass, hills, rock, snow. */
const RAMP: [number, number][] = [
  [0, 0xc9dba0],
  [0.45, 0xdcd4a2],
  [0.7, 0xcbb68e],
  [0.87, 0xa39687],
  [0.95, 0xd9d6cf],
  [1, 0xf4f2ee],
];
const SAND = 0xeadba9;
const SHALLOW = 0x4b9fc1;
/** Tiles from shore at which the sea reaches full depth. */
const DEEP = 16;

function ramp(h: number): number {
  for (let k = 1; k < RAMP.length; k++) {
    const [h1, c1] = RAMP[k];
    if (h <= h1) {
      const [h0, c0] = RAMP[k - 1];
      return mix(c0, c1, (h - h0) / (h1 - h0));
    }
  }
  return RAMP[RAMP.length - 1][1];
}
export const OPEN_SEA = 0x173d57;
/** Bombed land, while the fallout lasts. */
const SCORCHED = 0x4a4636;
const INK = '#0f1c27';
const DANGER = '#ff5a5a';
const ICON_PATHS = Object.fromEntries(Object.entries(ICONS).map(([k, d]) => [k, new Path2D(d)])) as Record<ToolKind, Path2D>;
const EXPLOSION_MS = 1100;

const NAME_FONT = '"Big Shoulders Display", "Arial Narrow", sans-serif';
const NUMBER_FONT = '"Public Sans", system-ui, sans-serif';

export interface Overlay {
  /** Tile under the mouse, or -1. */
  hover: number;
  /** While choosing a start: preview colour for the spawn area, else null. */
  spawnColor: number | null;
  spawnValid: boolean;
  /** The build or missile tool in hand, and whether the hovered tile is a valid spot. */
  tool: { kind: ToolKind; valid: boolean } | null;
  /** Ticks elapsed including the fraction since the last one, for smooth missiles. */
  tick: number;
  /** When the player spawned (ms), to pulse their marker for a while. */
  spawnedAt: number;
}

interface FloatText {
  tile: number;
  text: string;
  start: number;
}

interface Explosion {
  x: number;
  y: number;
  radius: number;
  start: number;
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
  /** Unlit landscape colour (0xRRGGBB) of each tile, blended under territory. */
  private readonly ground: Int32Array;
  /** Hill-shading factor of each tile (1 = flat). */
  private readonly light: Float32Array;
  private readonly playerRgb: Int32Array;
  private readonly borders: Uint32Array;
  private readonly capitalInk: string[];
  private dirty = { x0: 0, y0: 0, x1: -1, y1: -1 };
  private explosions: Explosion[] = [];
  private floats: FloatText[] = [];
  /** Bombed areas to repaint once their fallout ends. */
  private scorched: { tiles: number[]; until: number }[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly game: Game,
    /** The local player, whose border is drawn in white. */
    private readonly me: number | null = null,
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
    this.ground = new Int32Array(game.size);
    this.light = new Float32Array(game.size).fill(1);
    this.base = this.paintBase();

    const slots = game.players.length + 1;
    this.playerRgb = new Int32Array(slots);
    this.borders = new Uint32Array(slots);
    this.capitalInk = new Array<string>(slots).fill('#000');
    for (const p of game.players) {
      this.playerRgb[p.id] = p.color;
      this.borders[p.id] = p.id === me ? toPixel(0xffffff) : toPixel(shade(p.color, -0.38));
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
    for (const t of tiles) {
      const x = t % w;
      this.paint(t);
      if (x > 0) this.paint(t - 1);
      if (x < w - 1) this.paint(t + 1);
      if (t >= w) this.paint(t - w);
      if (t + w < size) this.paint(t + w);
      this.markDirty(x, (t - x) / w, 1);
    }
    // Fallout wears off: repaint the scorched land.
    const now = this.game.tick;
    const expired = this.scorched.filter((s) => s.until <= now);
    if (expired.length) {
      this.scorched = this.scorched.filter((s) => s.until > now);
      for (const s of expired) this.applyChanges(s.tiles);
    }
  }

  /** Gold rising from a spot, e.g. "+10K" where a train stops. */
  floatText(tile: number, text: string): void {
    this.floats.push({ tile, text, start: performance.now() });
  }

  /** Flash and shockwave where a missile lands, and scorch the ground. */
  explode(m: Missile): void {
    const { width: w, height: h } = this.game;
    const r = CONFIG.missiles[m.kind].radius;
    const cx = m.to % w;
    const cy = (m.to - cx) / w;
    const tiles: number[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (dx * dx + dy * dy <= r * r && x >= 0 && y >= 0 && x < w && y < h) tiles.push(y * w + x);
      }
    }
    this.applyChanges(tiles);
    this.scorched.push({ tiles, until: m.arrives + CONFIG.falloutTicks });
    this.explosions.push({ x: cx + 0.5, y: cy + 0.5, radius: r, start: performance.now() });
  }

  private markDirty(x: number, y: number, pad: number): void {
    const d = this.dirty;
    if (d.x1 < 0) {
      d.x0 = d.x1 = x;
      d.y0 = d.y1 = y;
    }
    d.x0 = Math.min(d.x0, x - pad);
    d.y0 = Math.min(d.y0, y - pad);
    d.x1 = Math.max(d.x1, x + pad);
    d.y1 = Math.max(d.y1, y + pad);
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
    const now = performance.now();
    this.drawRails(camera, dpr, overlay.tick);
    this.drawBoats(camera, dpr);
    this.drawBuildings(camera, dpr);
    this.drawCapitals(camera, dpr);
    this.drawLabels(camera, dpr);
    this.drawYou(camera, dpr, now, overlay.spawnedAt);
    this.drawMissiles(camera, dpr, now, overlay.tick);
    this.drawExplosions(camera, now);
    this.drawFloats(camera, dpr, now);
    this.drawSpawnPreview(camera, overlay, dpr);
    this.drawToolPreview(camera, overlay, dpr);
  }

  private paint(i: number): void {
    const { owner, width: w, size } = this.game;
    const o = owner[i];
    if (o === NEUTRAL) {
      this.pixels[i] =
        this.game.fallout[i] > this.game.tick && this.game.map.terrain[i] !== Terrain.Water
          ? this.scorchedPixel(i)
          : this.base[i];
      return;
    }
    const x = i % w;
    const edge =
      (x > 0 && owner[i - 1] !== o) ||
      (x < w - 1 && owner[i + 1] !== o) ||
      (i >= w && owner[i - w] !== o) ||
      (i + w < size && owner[i + w] !== o);
    this.pixels[i] = edge ? this.borders[o] : this.lit(mix(this.playerRgb[o], this.ground[i], 0.3), this.light[i]);
  }

  /** A colour brightened or darkened by hill shading, as a pixel. */
  private lit(rgb: number, k: number): number {
    const r = Math.min(255, ((rgb >> 16) & 255) * k);
    const g = Math.min(255, ((rgb >> 8) & 255) * k);
    const b = Math.min(255, (rgb & 255) * k);
    return toPixel((r << 16) | (g << 8) | b);
  }

  private scorchedPixel(i: number): number {
    return this.lit(mix(this.ground[i], SCORCHED, 0.72 + ((i * 7919) % 5) * 0.05), this.light[i]);
  }

  /**
   * The landscape: a colour ramp from meadow to snow by height, lit from the
   * north-west so hills stand out; sand on low coasts; water that deepens
   * from turquoise to navy with a pale line of surf along the shore.
   */
  private paintBase(): Uint32Array {
    const { width: w, size } = this.game;
    const { terrain, relief } = this.game.map;
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
      if (next > DEEP) continue;
      const x = t % w;
      if (x > 0 && depth[t - 1] === 255) (depth[t - 1] = next), (queue[tail++] = t - 1);
      if (x < w - 1 && depth[t + 1] === 255) (depth[t + 1] = next), (queue[tail++] = t + 1);
      if (t >= w && depth[t - w] === 255) (depth[t - w] = next), (queue[tail++] = t - w);
      if (t + w < size && depth[t + w] === 255) (depth[t + w] = next), (queue[tail++] = t + w);
    }

    const base = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const grain = 1 + (((i * 2654435761) >>> 24) / 255 - 0.5) * 0.05;
      if (terrain[i] === Terrain.Water) {
        const d = Math.min(DEEP, depth[i]) / DEEP;
        const deep = d * d * (3 - 2 * d);
        let color = mix(SHALLOW, OPEN_SEA, deep);
        if (depth[i] === 1) color = mix(color, 0xffffff, 0.22);
        this.ground[i] = color;
        base[i] = this.lit(color, grain);
        continue;
      }
      const x = i % w;
      const h = relief[i] / 255;
      let color = ramp(h);
      const shore = depth[i] === 0 && (
        (x > 0 && terrain[i - 1] === Terrain.Water) ||
        (x < w - 1 && terrain[i + 1] === Terrain.Water) ||
        (i >= w && terrain[i - w] === Terrain.Water) ||
        (i + w < size && terrain[i + w] === Terrain.Water));
      if (shore && h < 0.55) color = SAND;
      // Slope towards the light (up and to the left) is bright, away from it dark.
      const at = (n: number) => (n >= 0 && n < size && terrain[n] !== Terrain.Water ? relief[n] : relief[i] * 0.6);
      const gx = at(x < w - 1 ? i + 1 : i) - at(x > 0 ? i - 1 : i);
      const gy = at(i + w) - at(i - w);
      const k = Math.max(0.72, Math.min(1.28, 1 + (gx + gy) * 0.018)) * grain;
      this.ground[i] = color;
      this.light[i] = k;
      base[i] = this.lit(color, k);
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

  private screen(camera: Camera, tile: number): [number, number] {
    const x = tile % this.game.width;
    const y = (tile - x) / this.game.width;
    return [camera.x + (x + 0.5) * camera.scale, camera.y + (y + 0.5) * camera.scale];
  }

  private visible(sx: number, sy: number, margin: number): boolean {
    return sx > -margin && sy > -margin && sx < this.canvas.width + margin && sy < this.canvas.height + margin;
  }

  /** Rails from each factory through its stops, and trains running on them. */
  private drawRails(camera: Camera, dpr: number, tick: number): void {
    const { ctx, game } = this;
    const w = game.width;
    const point = (t: number): [number, number] => this.screen(camera, t);
    ctx.lineCap = 'round';
    for (const b of game.buildings) {
      if (b.kind !== 'factory') continue;
      const route = [b.tile, ...game.railRoute(b)];
      if (route.length < 2) continue;
      ctx.beginPath();
      route.forEach((t, i) => {
        const [x, y] = point(t);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineWidth = Math.max(3 * dpr, camera.scale * 0.9);
      ctx.strokeStyle = 'rgba(15, 28, 39, 0.75)';
      ctx.stroke();
      ctx.setLineDash([2 * dpr, 3 * dpr]);
      ctx.lineWidth = Math.max(1.2 * dpr, camera.scale * 0.35);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const t of game.trains) {
      const a = t.route[t.leg - 1];
      const b = t.route[t.leg];
      const ax = a % w;
      const ay = Math.floor(a / w);
      const dx = (b % w) - ax;
      const dy = Math.floor(b / w) - ay;
      const len = Math.max(0.001, Math.hypot(dx, dy));
      // Smooth between ticks: estimate the fraction of this tick already run.
      const k = Math.min(1, (t.progress + (tick % 1) * 1.2) / len);
      const [x, y] = [camera.x + (ax + dx * k + 0.5) * camera.scale, camera.y + (ay + dy * k + 0.5) * camera.scale];
      const size = Math.max(6 * dpr, camera.scale * 2);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = this.capitalInk[t.owner];
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.roundRect(-size, -size / 2.4, size * 2, size / 1.2, size / 4);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Boats under way: their route ahead, dashed, and the boat itself. */
  private drawBoats(camera: Camera, dpr: number): void {
    const { ctx } = this;
    for (const b of this.game.boats) {
      const i = Math.min(b.path.length - 1, Math.floor(b.pos));
      ctx.beginPath();
      for (let k = i; k < b.path.length; k += 2) {
        const [x, y] = this.screen(camera, b.path[k]);
        if (k === i) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const [ex, ey] = this.screen(camera, b.path[b.path.length - 1]);
      ctx.lineTo(ex, ey);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = b.owner === this.me ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.35)';
      ctx.stroke();
      ctx.setLineDash([]);
      const [x, y] = this.screen(camera, b.path[i]);
      const r = Math.max(6 * dpr, camera.scale * 1.8);
      // Hull and sail.
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x + r * 0.6, y + r * 0.55);
      ctx.lineTo(x - r * 0.6, y + r * 0.55);
      ctx.closePath();
      ctx.fillStyle = this.capitalInk[b.owner];
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x + r * 0.7, y - r * 0.1);
      ctx.lineTo(x, y - r * 0.1);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
  }

  private drawFloats(camera: Camera, dpr: number, now: number): void {
    const { ctx } = this;
    this.floats = this.floats.filter((f) => now - f.start < 1600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${14 * dpr}px "Public Sans", system-ui, sans-serif`;
    for (const f of this.floats) {
      const t = (now - f.start) / 1600;
      const [x, y] = this.screen(camera, f.tile);
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = INK;
      ctx.strokeText(f.text, x, y - (14 + t * 30) * dpr);
      ctx.fillStyle = '#f2c14e';
      ctx.fillText(f.text, x, y - (14 + t * 30) * dpr);
    }
    ctx.globalAlpha = 1;
  }

  /** A white disc ringed in the owner's colour, with the building's symbol. */
  private drawIcon(kind: ToolKind, sx: number, sy: number, size: number, ring: string, alpha = 1): void {
    const { ctx } = this;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, size * 0.11);
    ctx.strokeStyle = ring;
    ctx.stroke();
    ctx.save();
    const k = (size * 0.62) / 16;
    ctx.translate(sx - 8 * k, sy - 8 * k);
    ctx.scale(k, k);
    ctx.fillStyle = INK;
    ctx.fill(ICON_PATHS[kind], 'evenodd');
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawBuildings(camera: Camera, dpr: number): void {
    const size = Math.min(26 * dpr, Math.max(11 * dpr, camera.scale * 3.2));
    for (const b of this.game.buildings) {
      const [sx, sy] = this.screen(camera, b.tile);
      if (!this.visible(sx, sy, size)) continue;
      this.drawIcon(b.kind, sx, sy, size, this.capitalInk[b.owner]);
    }
  }

  /** Makes your own start impossible to miss: a pulsing ring and a YOU tag, or an arrow when off screen. */
  private drawYou(camera: Camera, dpr: number, now: number, spawnedAt: number): void {
    if (this.me === null) return;
    const p = this.game.player(this.me);
    if (!p.alive || p.capital < 0) return;
    const { ctx, canvas } = this;
    const [sx, sy] = this.screen(camera, p.capital);
    const margin = 24 * dpr;
    if (!this.visible(sx, sy, -margin)) {
      // Arrow at the screen edge, pointing at your capital.
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const angle = Math.atan2(sy - cy, sx - cx);
      const reach = Math.min((cx - margin) / Math.abs(Math.cos(angle) || 1e-6), (cy - margin) / Math.abs(Math.sin(angle) || 1e-6));
      const ax = cx + Math.cos(angle) * reach;
      const ay = cy + Math.sin(angle) * reach;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(14 * dpr, 0);
      ctx.lineTo(-8 * dpr, -10 * dpr);
      ctx.lineTo(-3 * dpr, 0);
      ctx.lineTo(-8 * dpr, 10 * dpr);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
      ctx.fill();
      ctx.restore();
      return;
    }
    // Rings ripple outwards for the first 20 seconds, then one stays.
    const fresh = now - spawnedAt < 20000;
    ctx.lineWidth = 2.5 * dpr;
    for (let k = 0; k < (fresh ? 2 : 1); k++) {
      const phase = fresh ? ((now / 1400 + k / 2) % 1) : 0.35;
      ctx.beginPath();
      ctx.arc(sx, sy, (16 + phase * 38) * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${fresh ? (1 - phase) * 0.9 : 0.55})`;
      ctx.stroke();
    }
    const font = `800 ${13 * dpr}px "Public Sans", system-ui, sans-serif`;
    ctx.font = font;
    const text = 'DU';
    const w = ctx.measureText(text).width + 12 * dpr;
    const h = 18 * dpr;
    const ty = sy - 30 * dpr - h;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(sx - w / 2, ty, w, h, 5 * dpr);
    ctx.moveTo(sx - 5 * dpr, ty + h);
    ctx.lineTo(sx + 5 * dpr, ty + h);
    ctx.lineTo(sx, ty + h + 6 * dpr);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, sx, ty + h / 2 + dpr);
  }

  /** Missiles arc from silo to target; the target shows its blast radius. */
  private drawMissiles(camera: Camera, dpr: number, now: number, tick: number): void {
    const { ctx } = this;
    for (const m of this.game.missiles) {
      const [x0, y0] = this.screen(camera, m.from);
      const [x1, y1] = this.screen(camera, m.to);
      const t = Math.min(1, Math.max(0, (tick - m.launched) / (m.arrives - m.launched)));
      const color = m.owner === this.me ? '#ffffff' : m.victim === this.me ? DANGER : '#ffc14d';
      // Control point lifted above the midpoint, so the path reads as a flight.
      const lift = Math.hypot(x1 - x0, y1 - y0) * 0.35;
      const qx = (x0 + x1) / 2;
      const qy = (y0 + y1) / 2 - lift;
      const at = (u: number): [number, number] => [
        (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * qx + u * u * x1,
        (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * qy + u * u * y1,
      ];

      // Blast radius at the target, pulsing.
      const r = CONFIG.missiles[m.kind].radius * camera.scale;
      const pulse = 0.5 + 0.5 * Math.sin(now / 160);
      ctx.beginPath();
      ctx.arc(x1, y1, Math.max(6 * dpr, r), 0, Math.PI * 2);
      ctx.fillStyle = m.victim === this.me && m.owner !== this.me ? `rgba(255, 90, 90, ${0.12 + 0.12 * pulse})` : `rgba(255, 193, 77, ${0.08 + 0.08 * pulse})`;
      ctx.fill();
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = color;
      ctx.stroke();

      // The path still to fly, dashed, and the trail behind, solid.
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) {
        const [px, py] = at(t + ((1 - t) * k) / 24);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.globalAlpha = 0.45;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) {
        const [px, py] = at((t * k) / 24);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();

      const [hx, hy] = at(t);
      ctx.beginPath();
      ctx.arc(hx, hy, (m.kind === 'nuke' ? 5 : 3.5) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12 * dpr;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  private drawExplosions(camera: Camera, now: number): void {
    const { ctx } = this;
    this.explosions = this.explosions.filter((e) => now - e.start < EXPLOSION_MS);
    for (const e of this.explosions) {
      const t = (now - e.start) / EXPLOSION_MS;
      const sx = camera.x + e.x * camera.scale;
      const sy = camera.y + e.y * camera.scale;
      const r = e.radius * camera.scale;
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * (0.6 + t * 0.6));
      glow.addColorStop(0, `rgba(255, 244, 214, ${0.95 * (1 - t)})`);
      glow.addColorStop(0.45, `rgba(255, 150, 60, ${0.75 * (1 - t)})`);
      glow.addColorStop(1, 'rgba(255, 80, 40, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, r * (0.6 + t * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, r * (0.4 + t * 1.2), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, r * 0.08 * (1 - t));
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * (1 - t)})`;
      ctx.stroke();
    }
  }

  /** Ghost of the building, or the blast radius of the missile, under the cursor. */
  private drawToolPreview(camera: Camera, overlay: Overlay, dpr: number): void {
    const tool = overlay.tool;
    if (!tool || overlay.hover < 0) return;
    const { ctx } = this;
    const [sx, sy] = this.screen(camera, overlay.hover);
    const color = tool.valid ? '#ffffff' : DANGER;
    if (isMissile(tool.kind)) {
      const r = Math.max(8 * dpr, CONFIG.missiles[tool.kind].radius * camera.scale);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 90, 90, 0.18)';
      ctx.fill();
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sx - r * 0.35, sy);
      ctx.lineTo(sx + r * 0.35, sy);
      ctx.moveTo(sx, sy - r * 0.35);
      ctx.lineTo(sx, sy + r * 0.35);
      ctx.stroke();
      return;
    }
    if (tool.kind === 'defense') {
      ctx.beginPath();
      ctx.arc(sx, sy, CONFIG.defenseRadius * camera.scale, 0, Math.PI * 2);
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const size = Math.min(26 * dpr, Math.max(14 * dpr, camera.scale * 3.2));
    this.drawIcon(tool.kind, sx, sy, size, color, tool.valid ? 0.9 : 0.6);
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
