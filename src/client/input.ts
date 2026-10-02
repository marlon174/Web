import type { Camera } from './camera';

export interface InputTarget {
  /** A click or tap that didn't turn into a drag. Coordinates are canvas pixels. */
  tap(sx: number, sy: number): void;
  hover(sx: number, sy: number): void;
  leave(): void;
  /** Called after the camera moves, to keep it in bounds. */
  moved(): void;
  /** Right-click: put down whatever tool is in hand. */
  cancel(): void;
}

interface Point {
  x: number;
  y: number;
}

/** Mouse, pen and touch: tap to act, drag to pan, wheel or pinch to zoom. */
export class Input {
  private readonly pointers = new Map<number, Point>();
  private press: (Point & { button: number }) | null = null;
  private dragging = false;
  private pinchDistance = 0;
  private pinchMid: Point = { x: 0, y: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly target: InputTarget,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose(): void {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('contextmenu', this.onContextMenu);
    c.classList.remove('dragging');
  }

  private point(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / Math.max(1, rect.width);
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
  }

  private onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.point(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.press = { ...p, button: e.button };
      this.dragging = false;
    } else if (this.pointers.size === 2) {
      // A second finger means a pinch, never a tap.
      this.press = null;
      this.dragging = true;
      this.startPinch();
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.point(e);
    const previous = this.pointers.get(e.pointerId);
    if (!previous) {
      if (e.pointerType === 'mouse') this.target.hover(p.x, p.y);
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (!this.dragging && this.press) {
      const slop = (e.pointerType === 'touch' ? 12 : 6) * (this.canvas.width / Math.max(1, this.canvas.clientWidth));
      if (Math.hypot(p.x - this.press.x, p.y - this.press.y) > slop) {
        this.dragging = true;
        this.canvas.classList.add('dragging');
      }
    }
    if (this.dragging) {
      this.camera.panBy(p.x - previous.x, p.y - previous.y);
      this.target.moved();
    }
    if (e.pointerType === 'mouse') this.target.hover(p.x, p.y);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size === 0) {
      if (e.type === 'pointerup' && this.press && !this.dragging && this.press.button === 0) {
        const p = this.point(e);
        this.target.tap(p.x, p.y);
      }
      this.press = null;
      this.dragging = false;
      this.canvas.classList.remove('dragging');
    }
  };

  private onLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && this.pointers.size === 0) this.target.leave();
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.point(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.camera.zoomAt(p.x, p.y, Math.exp(-delta * 0.0015));
    this.target.moved();
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
    this.target.cancel();
  };

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private updatePinch(): void {
    const [a, b] = [...this.pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this.pinchDistance > 0) this.camera.zoomAt(mid.x, mid.y, distance / this.pinchDistance);
    this.camera.panBy(mid.x - this.pinchMid.x, mid.y - this.pinchMid.y);
    this.pinchDistance = distance;
    this.pinchMid = mid;
    this.target.moved();
  }
}
