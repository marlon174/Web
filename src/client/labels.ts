import { NEUTRAL, type Game } from '../core/game';

export interface Label {
  /** Centre in tile units, eased towards the target each frame. */
  x: number;
  y: number;
  /** Radius of the widest open spot in the territory, in tiles. */
  radius: number;
  tx: number;
  ty: number;
  tradius: number;
}

/**
 * Places each player's name at the point of their territory farthest from
 * any border, using one chamfer distance transform over the whole map.
 */
export class LabelLayout {
  readonly labels = new Map<number, Label>();
  private readonly dist: Uint16Array;
  private readonly best: Int32Array;
  private readonly bestTile: Int32Array;

  constructor(private readonly game: Game) {
    this.dist = new Uint16Array(game.size);
    this.best = new Int32Array(game.players.length + 1);
    this.bestTile = new Int32Array(game.players.length + 1);
  }

  recompute(): void {
    const { owner, width: w, height: h } = this.game;
    const d = this.dist;

    // Forward pass. Edge tiles of a territory start at 3 (one step); orthogonal steps cost 3, diagonals 4.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = owner[i];
        if (o === NEUTRAL) {
          d[i] = 0;
          continue;
        }
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || owner[i - 1] !== o || owner[i + 1] !== o || owner[i - w] !== o || owner[i + w] !== o) {
          d[i] = 3;
          continue;
        }
        let v = Math.min(d[i - 1], d[i - w]) + 3;
        if (owner[i - w - 1] === o) v = Math.min(v, d[i - w - 1] + 4);
        if (owner[i - w + 1] === o) v = Math.min(v, d[i - w + 1] + 4);
        d[i] = Math.min(v, 65535);
      }
    }
    // Backward pass.
    for (let y = h - 2; y > 0; y--) {
      for (let x = w - 2; x > 0; x--) {
        const i = y * w + x;
        const o = owner[i];
        if (o === NEUTRAL || d[i] === 3) continue;
        let v = Math.min(d[i], d[i + 1] + 3, d[i + w] + 3);
        if (owner[i + w + 1] === o) v = Math.min(v, d[i + w + 1] + 4);
        if (owner[i + w - 1] === o) v = Math.min(v, d[i + w - 1] + 4);
        d[i] = v;
      }
    }

    this.best.fill(0);
    for (let i = 0; i < d.length; i++) {
      const o = owner[i];
      if (o !== NEUTRAL && d[i] > this.best[o]) {
        this.best[o] = d[i];
        this.bestTile[o] = i;
      }
    }

    for (const p of this.game.players) {
      if (!p.alive || this.best[p.id] === 0) {
        this.labels.delete(p.id);
        continue;
      }
      const t = this.bestTile[p.id];
      const tx = (t % w) + 0.5;
      const ty = Math.floor(t / w) + 0.5;
      const tradius = this.best[p.id] / 3;
      const label = this.labels.get(p.id);
      if (label) {
        label.tx = tx;
        label.ty = ty;
        label.tradius = tradius;
      } else {
        this.labels.set(p.id, { x: tx, y: ty, radius: tradius, tx, ty, tradius });
      }
    }
  }

  /** Eases labels towards their targets so they glide instead of jumping. */
  animate(seconds: number): void {
    const k = 1 - Math.exp(-seconds * 6);
    for (const l of this.labels.values()) {
      l.x += (l.tx - l.x) * k;
      l.y += (l.ty - l.y) * k;
      l.radius += (l.tradius - l.radius) * k;
    }
  }
}
