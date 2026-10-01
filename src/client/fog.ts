import { NEUTRAL, type Game } from '../core/game';

/** Fog works on blocks of this many tiles a side: cheap to update and soft at the edges. */
const CELL = 8;
/** How far you see past your own land, boats and ships, in half-cells (a straight step costs 2, a diagonal 3). */
const SIGHT = 6;
/** Width of the soft edge, in half-cells. */
const FADE = 4;
const FOG_RGB = [12, 22, 32];

/**
 * Fog of war, drawn over the map: you see your own land, your allies', and a
 * band around them and your boats and warships; everything else is hidden.
 * Display only: the simulation still knows everything.
 */
export class Fog {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cols: number;
  private readonly rows: number;
  /** Distance in cells to the nearest thing you can see from; 255 when far. */
  private readonly dist: Uint8Array;
  private readonly queue: Int32Array;
  private readonly image: ImageData;
  /** False before you have a start and after you're out: then nothing is hidden. */
  active = false;
  /** Players with any land in sight right now (by id). */
  private seen = new Uint8Array(0);

  constructor(private readonly game: Game, private readonly me: number) {
    this.cols = Math.ceil(game.width / CELL);
    this.rows = Math.ceil(game.height / CELL);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cols;
    this.canvas.height = this.rows;
    this.ctx = this.canvas.getContext('2d')!;
    this.dist = new Uint8Array(this.cols * this.rows);
    // Cells can be queued again when a shorter way turns up; a few times each at most.
    this.queue = new Int32Array(this.cols * this.rows * 6);
    this.image = this.ctx.createImageData(this.cols, this.rows);
  }

  update(): void {
    const { game, me, cols, rows, dist, queue } = this;
    const player = game.player(me);
    this.active = player.spawned && player.alive;
    if (!this.active) return;

    dist.fill(255);
    let tail = 0;
    const seed = (tile: number) => {
      const x = tile % game.width;
      const c = Math.floor((tile - x) / game.width / CELL) * cols + Math.floor(x / CELL);
      if (dist[c] !== 0) {
        dist[c] = 0;
        queue[tail++] = c;
      }
    };
    const { owner, size } = game;
    const friends = new Uint8Array(game.players.length + 1);
    friends[me] = 1;
    for (const p of game.players) if (game.allied(me, p.id)) friends[p.id] = 1;
    for (let t = 0; t < size; t++) {
      const o = owner[t];
      if (o !== NEUTRAL && friends[o]) seed(t);
    }
    for (const b of game.boats) if (friends[b.owner]) seed(b.path[Math.min(b.path.length - 1, Math.floor(b.pos))]);
    for (const s of game.warships) if (friends[s.owner]) seed(s.tile);

    // Spread outwards (2 per straight step, 3 per diagonal: close to round), far enough to fade out.
    // Re-queue a cell whenever it gets closer; the band is narrow, so this stays cheap.
    for (let head = 0; head < tail; head++) {
      const c = queue[head];
      const cx = c % cols;
      const cy = (c - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const d = dist[c] + (dx !== 0 && dy !== 0 ? 3 : 2);
          if (d > SIGHT + FADE) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const n = y * cols + x;
          if (dist[n] > d && tail < queue.length) {
            dist[n] = d;
            queue[tail++] = n;
          }
        }
      }
    }

    const data = this.image.data;
    for (let c = 0; c < dist.length; c++) {
      const fade = Math.min(1, Math.max(0, (dist[c] - SIGHT) / FADE));
      const k = c * 4;
      data[k] = FOG_RGB[0];
      data[k + 1] = FOG_RGB[1];
      data[k + 2] = FOG_RGB[2];
      // Fully opaque beyond the soft edge: nothing shows through.
      data[k + 3] = Math.round(fade * 255);
    }
    this.ctx.putImageData(this.image, 0, 0);

    // Who is in sight: the board hides everyone else's numbers.
    const seen = new Uint8Array(game.players.length + 1);
    for (let t = 0; t < size; t++) {
      const o = owner[t];
      if (o === NEUTRAL || seen[o]) continue;
      const x = t % game.width;
      const c = Math.floor((t - x) / game.width / CELL) * cols + Math.floor(x / CELL);
      if (dist[c] <= SIGHT) seen[o] = 1;
    }
    for (let id = 1; id < friends.length; id++) if (friends[id]) seen[id] = 1;
    this.seen = seen;
  }

  /** Whether a player is out of sight entirely (none of their land is visible). */
  unseen(id: number): boolean {
    return this.active && this.seen[id] !== 1;
  }

  /** Whether a tile is out of sight. */
  hidden(tile: number): boolean {
    if (!this.active) return false;
    const x = tile % this.game.width;
    const c = Math.floor((tile - x) / this.game.width / CELL) * this.cols + Math.floor(x / CELL);
    return this.dist[c] > SIGHT;
  }

  /** Draws the fog over a map drawn at `scale` with its corner at (x, y). */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
    if (!this.active) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, x, y, this.cols * CELL * scale, this.rows * CELL * scale);
    ctx.restore();
  }
}
