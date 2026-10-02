/**
 * Seeded random numbers (sfc32). Integer maths only, so every browser gets
 * the same sequence from the same seed. The simulation never calls
 * Math.random.
 */
export class Rng {
  private a = 0x9e3779b9;
  private b = 0x243f6a88;
  private c = 0xb7e15162;
  private d: number;

  constructor(seed: number) {
    this.d = seed | 0;
    for (let i = 0; i < 16; i++) this.u32();
  }

  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) | 0;
    return t >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

/** Stateless hash of a lattice point to [0, 1), used by the map noise. */
export function hash2(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
