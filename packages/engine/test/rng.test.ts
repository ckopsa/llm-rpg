import { describe, expect, it } from "vitest";
import { Rng } from "../src/rng.js";

describe("Rng", () => {
  it("same seed produces the same sequence", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it("different seeds diverge", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("resumes exactly from serialized state", () => {
    const a = new Rng(7);
    for (let i = 0; i < 13; i++) a.next();
    const b = Rng.fromState(a.getState());
    for (let i = 0; i < 50; i++) expect(b.next()).toBe(a.next());
  });

  it("int stays within inclusive bounds", () => {
    const rng = new Rng(3);
    for (let i = 0; i < 1000; i++) {
      const n = rng.int(2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it("pickWeighted respects weights roughly", () => {
    const rng = new Rng(9);
    const items = [
      { id: "common", weight: 90 },
      { id: "rare", weight: 10 },
    ];
    let rare = 0;
    for (let i = 0; i < 1000; i++) {
      if (rng.pickWeighted(items).id === "rare") rare++;
    }
    expect(rare).toBeGreaterThan(50);
    expect(rare).toBeLessThan(200);
  });
});
