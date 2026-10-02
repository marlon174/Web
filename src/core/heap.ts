/** Room for maps up to 2^23 (about 8.4 million) tiles. */
const SPAN = 8388608;

/**
 * Min-heap of tile indices ordered by an integer key (the tick a tile is
 * ready to fall). Key and tile are packed into one float64 so the heap is a
 * single typed array; equal keys pop in tile order, which keeps it
 * deterministic.
 */
export class TileHeap {
  size = 0;
  private items: Float64Array;

  constructor(capacity = 64) {
    this.items = new Float64Array(capacity);
  }

  push(key: number, tile: number): void {
    if (this.size === this.items.length) {
      const grown = new Float64Array(this.size * 2);
      grown.set(this.items);
      this.items = grown;
    }
    const items = this.items;
    const value = key * SPAN + tile;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent] <= value) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = value;
  }

  /** Key of the smallest item. Only valid while size > 0. */
  peekKey(): number {
    return Math.floor(this.items[0] / SPAN);
  }

  /** Removes the smallest item and returns its tile. Only valid while size > 0. */
  pop(): number {
    const items = this.items;
    const top = items[0];
    const last = items[--this.size];
    const n = this.size;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && items[child + 1] < items[child]) child++;
      if (items[child] >= last) break;
      items[i] = items[child];
      i = child;
    }
    items[i] = last;
    return top % SPAN;
  }
}
