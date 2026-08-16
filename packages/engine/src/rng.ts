/**
 * Deterministic, serializable RNG (mulberry32). All engine randomness —
 * encounter rolls, damage rolls, accuracy — must flow through an Rng so a
 * (seed, action list) pair fully determines a playthrough and battles replay
 * exactly after save/load.
 */

export interface RngState {
  s: number;
}

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  static fromState(state: RngState): Rng {
    const rng = new Rng(0);
    rng.s = state.s >>> 0;
    return rng;
  }

  getState(): RngState {
    return { s: this.s };
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick an element with probability proportional to its weight. */
  pickWeighted<T extends { weight: number }>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pickWeighted: empty list");
    const total = items.reduce((sum, i) => sum + i.weight, 0);
    if (total <= 0) throw new Error("pickWeighted: total weight must be > 0");
    let roll = this.next() * total;
    for (const item of items) {
      roll -= item.weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1];
  }
}
