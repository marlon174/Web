export interface Inset {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Maps tiles to canvas pixels: screen = tile × scale + offset. */
export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  fitScale = 1;
  /** Set once the player pans or zooms, so resizes stop re-fitting the map. */
  moved = false;

  fit(viewW: number, viewH: number, mapW: number, mapH: number, inset: Inset): void {
    const w = Math.max(1, viewW - inset.left - inset.right);
    const h = Math.max(1, viewH - inset.top - inset.bottom);
    this.scale = this.fitScale = Math.min(w / mapW, h / mapH) * 0.94;
    this.x = inset.left + (w - mapW * this.scale) / 2;
    this.y = inset.top + (h - mapH * this.scale) / 2;
    this.moved = false;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const next = Math.min(this.fitScale * 30, Math.max(this.fitScale * 0.6, this.scale * factor));
    const k = next / this.scale;
    this.x = sx - (sx - this.x) * k;
    this.y = sy - (sy - this.y) * k;
    this.scale = next;
    this.moved = true;
  }

  panBy(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.moved = true;
  }

  centerOn(tileX: number, tileY: number, viewW: number, viewH: number): void {
    this.x = viewW / 2 - (tileX + 0.5) * this.scale;
    this.y = viewH / 2 - (tileY + 0.5) * this.scale;
    this.moved = true;
  }

  /** Keeps at least a quarter of the view on the map. */
  clamp(viewW: number, viewH: number, mapW: number, mapH: number): void {
    const w = mapW * this.scale;
    const h = mapH * this.scale;
    this.x = Math.min(viewW * 0.75, Math.max(viewW * 0.25 - w, this.x));
    this.y = Math.min(viewH * 0.75, Math.max(viewH * 0.25 - h, this.y));
  }

  /** Tile under a canvas pixel, or -1 off the map. */
  tileAt(sx: number, sy: number, mapW: number, mapH: number): number {
    const x = Math.floor((sx - this.x) / this.scale);
    const y = Math.floor((sy - this.y) / this.scale);
    if (x < 0 || y < 0 || x >= mapW || y >= mapH) return -1;
    return y * mapW + x;
  }
}
