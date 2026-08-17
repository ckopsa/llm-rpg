import { describe, expect, it } from "vitest";
import { opaqueColors, type PixelBuffer } from "./recolor";
import {
  CELL,
  addOutlineRing,
  convertSketch,
  fitSubject,
  flattenIllumination,
  hardenAlpha,
  isolateSubject,
  keyBackground,
  placeInCell,
  quantizeColors,
  resizeAreaAverage,
  trimToContent,
  verifySprite,
} from "./sketchImport";

function makeImage(width: number, height: number, fill: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return { width, height, data };
}

function setPixel(img: PixelBuffer, x: number, y: number, rgba: [number, number, number, number]): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgba[0];
  img.data[i + 1] = rgba[1];
  img.data[i + 2] = rgba[2];
  img.data[i + 3] = rgba[3];
}

function getPixel(img: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** A 40x40 "pencil sketch": white paper, a dark 2px-thick square ring drawn
 *  around a plain (uncolored) white interior -- exactly the shape a child's
 *  line-only sketch takes. `gap` punches a hole in the top edge of the ring
 *  so the outline is not a closed curve, matching the real failure mode. */
function sketchWithGap(gap: number): PixelBuffer {
  const img = makeImage(40, 40, [255, 255, 255, 255]);
  const ink: [number, number, number, number] = [20, 20, 20, 255];
  for (let x = 8; x <= 31; x++) {
    for (const y of [8, 9, 30, 31]) setPixel(img, x, y, ink);
  }
  for (let y = 8; y <= 31; y++) {
    for (const x of [8, 9, 30, 31]) setPixel(img, x, y, ink);
  }
  if (gap > 0) {
    const start = 18;
    for (let x = start; x < start + gap; x++) {
      setPixel(img, x, 8, [255, 255, 255, 255]);
      setPixel(img, x, 9, [255, 255, 255, 255]);
    }
  }
  return img;
}

describe("flattenIllumination", () => {
  it("flattens a mild, smooth lighting gradient so a uniform sheet reads as ~uniform", () => {
    const img = makeImage(60, 60, [255, 255, 255, 255]);
    // A gentle vignette -- the kind real indoor photo lighting actually
    // produces (pixelize.py/sketch2sprite.py's target case), not a
    // dramatic 2x swing. See flattenIllumination's doc comment: the
    // correction factor is deliberately clamped so it cannot bleach a
    // large solid-colored subject toward white, which caps how much a
    // single flattening pass can correct.
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) {
        const factor = 1 - (x + y) / 850; // 1.0 down to ~0.86
        const v = Math.round(255 * factor);
        setPixel(img, x, y, [v, v, v, 255]);
      }
    }
    const out = flattenIllumination(img, 0.3);
    const bright = getPixel(out, 5, 5);
    const dim = getPixel(out, 54, 54);
    // Both corners were flattened toward the same paper brightness; the
    // pre-flatten gap should have shrunk substantially.
    expect(Math.abs(bright[0] - dim[0])).toBeLessThan(15);
  });

  it("leaves alpha untouched", () => {
    const img = makeImage(20, 20, [200, 180, 160, 200]);
    const out = flattenIllumination(img);
    for (let p = 3; p < out.data.length; p += 4) expect(out.data[p]).toBe(200);
  });
});

describe("keyBackground", () => {
  it("keys a uniform background to transparent and keeps a distinct subject opaque", () => {
    const img = makeImage(20, 20, [250, 250, 250, 255]);
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) setPixel(img, x, y, [30, 30, 30, 255]);
    }
    const out = keyBackground(img);
    expect(getPixel(out, 0, 0)[3]).toBe(0);
    expect(getPixel(out, 10, 10)[3]).toBe(255);
  });

  it("bridges a gap in the outline instead of leaking through it (the core sketch2sprite fix)", () => {
    const gapped = sketchWithGap(3);
    const bridged = keyBackground(gapped, { bridge: 3 });
    // Far from any edge, deep in the ring's interior: bridging should have
    // closed the 3px gap and kept this enclosed region opaque.
    expect(getPixel(bridged, 20, 20)[3]).toBe(255);
    // The true exterior is still correctly keyed out.
    expect(getPixel(bridged, 0, 0)[3]).toBe(0);
  });

  it("without bridging, the same gap lets the flood leak through and empty the interior", () => {
    const gapped = sketchWithGap(3);
    const unbridged = keyBackground(gapped, { bridge: 0 });
    expect(getPixel(unbridged, 20, 20)[3]).toBe(0);
  });

  it("a fully closed outline needs no bridging", () => {
    const closed = sketchWithGap(0);
    const out = keyBackground(closed, { bridge: 0 });
    expect(getPixel(out, 20, 20)[3]).toBe(255);
  });
});

describe("isolateSubject", () => {
  it("keeps only the largest connected opaque component", () => {
    const img = makeImage(20, 20, [0, 0, 0, 0]);
    // big blob: 5x5 = 25px
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) setPixel(img, x, y, [100, 100, 100, 255]);
    // small stray mark, unconnected: 2px
    setPixel(img, 15, 15, [100, 100, 100, 255]);
    setPixel(img, 16, 15, [100, 100, 100, 255]);

    const out = isolateSubject(img);
    expect(getPixel(out, 4, 4)[3]).toBe(255);
    expect(getPixel(out, 15, 15)[3]).toBe(0);
    expect(getPixel(out, 16, 15)[3]).toBe(0);
  });

  it("is a no-op when there is only one component", () => {
    const img = makeImage(10, 10, [0, 0, 0, 0]);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) setPixel(img, x, y, [10, 20, 30, 255]);
    const out = isolateSubject(img);
    expect(getPixel(out, 3, 3)).toEqual([10, 20, 30, 255]);
  });
});

describe("trimToContent", () => {
  it("crops to the bounding box of opaque pixels", () => {
    const img = makeImage(10, 10, [0, 0, 0, 0]);
    setPixel(img, 3, 4, [1, 2, 3, 255]);
    setPixel(img, 6, 7, [4, 5, 6, 255]);
    const out = trimToContent(img);
    expect(out.width).toBe(4); // 3..6 inclusive
    expect(out.height).toBe(4); // 4..7 inclusive
    expect(getPixel(out, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(getPixel(out, 3, 3)).toEqual([4, 5, 6, 255]);
  });

  it("throws on a fully transparent image", () => {
    const img = makeImage(5, 5, [0, 0, 0, 0]);
    expect(() => trimToContent(img)).toThrow();
  });
});

describe("resizeAreaAverage / fitSubject", () => {
  it("averages a 2x2 block into one output pixel when downscaling by half", () => {
    const img = makeImage(4, 4, [0, 0, 0, 255]);
    setPixel(img, 0, 0, [0, 0, 0, 255]);
    setPixel(img, 1, 0, [100, 0, 0, 255]);
    setPixel(img, 0, 1, [0, 100, 0, 255]);
    setPixel(img, 1, 1, [0, 0, 100, 255]);
    const out = resizeAreaAverage(img, 2, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    const [r, g, b] = getPixel(out, 0, 0);
    expect(r).toBeCloseTo(25, 0);
    expect(g).toBeCloseTo(25, 0);
    expect(b).toBeCloseTo(25, 0);
  });

  it("fitSubject preserves aspect ratio and fits within the box", () => {
    const img = makeImage(100, 50, [10, 10, 10, 255]);
    const out = fitSubject(img, { w: 60, h: 60 });
    expect(out.width).toBeLessThanOrEqual(60);
    expect(out.height).toBeLessThanOrEqual(60);
    // 100x50 into a 60x60 box, aspect-preserved: width is the binding side
    expect(out.width).toBe(60);
    expect(out.height).toBe(30);
  });
});

describe("hardenAlpha", () => {
  it("snaps alpha to 0 or 255 at the threshold", () => {
    const img = makeImage(1, 4, [0, 0, 0, 0]);
    setPixel(img, 0, 0, [1, 1, 1, 0]);
    setPixel(img, 0, 1, [1, 1, 1, 127]);
    setPixel(img, 0, 2, [1, 1, 1, 128]);
    setPixel(img, 0, 3, [1, 1, 1, 255]);
    const out = hardenAlpha(img, 128);
    expect(getPixel(out, 0, 0)[3]).toBe(0);
    expect(getPixel(out, 0, 1)[3]).toBe(0);
    expect(getPixel(out, 0, 2)[3]).toBe(255);
    expect(getPixel(out, 0, 3)[3]).toBe(255);
  });
});

describe("quantizeColors", () => {
  it("never exceeds the requested color count", () => {
    const img = makeImage(30, 30, [0, 0, 0, 0]);
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) setPixel(img, x, y, [(x * 8) % 256, (y * 8) % 256, (x + y) % 256, 255]);
    }
    const out = quantizeColors(img, 6);
    expect(opaqueColors(out).length).toBeLessThanOrEqual(6);
  });

  it("preserves a small high-contrast feature (eyes) instead of quantizing it into the body color", () => {
    // ~880 opaque pixels of near-duplicate tan body tones (small per-pixel
    // jitter, the way a photographed/JPEG-compressed fill color behaves)
    // plus a 4px near-black "eye" cluster -- a miniature of the exact bug
    // pixelize.py's docstring calls out: a creature mostly one color that
    // MEDIANCUT would spend every slot on and delete the eye from.
    const img = makeImage(30, 30, [0, 0, 0, 0]);
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) {
        const jitter = () => Math.round((rand() - 0.5) * 6);
        setPixel(img, x, y, [200 + jitter(), 150 + jitter(), 100 + jitter(), 255]);
      }
    }
    setPixel(img, 14, 14, [10, 10, 10, 255]);
    setPixel(img, 15, 14, [10, 10, 10, 255]);
    setPixel(img, 14, 15, [10, 10, 10, 255]);
    setPixel(img, 15, 15, [10, 10, 10, 255]);

    const out = quantizeColors(img, 4);
    expect(opaqueColors(out).length).toBeLessThanOrEqual(4);

    const eye = getPixel(out, 14, 14);
    const eyeDistToOriginal = Math.hypot(eye[0] - 10, eye[1] - 10, eye[2] - 10);
    const eyeDistToBody = Math.hypot(eye[0] - 200, eye[1] - 150, eye[2] - 100);
    expect(eyeDistToOriginal).toBeLessThan(30);
    expect(eyeDistToBody).toBeGreaterThan(100);
  });

  it("is a no-op (up to exact-count passthrough) when already within budget", () => {
    const img = makeImage(4, 4, [0, 0, 0, 0]);
    setPixel(img, 0, 0, [10, 20, 30, 255]);
    setPixel(img, 1, 0, [40, 50, 60, 255]);
    const out = quantizeColors(img, 8);
    expect(getPixel(out, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(getPixel(out, 1, 0)).toEqual([40, 50, 60, 255]);
  });
});

describe("addOutlineRing", () => {
  it("draws a 1px ring outside the silhouette without eating into it", () => {
    const img = makeImage(10, 10, [0, 0, 0, 0]);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) setPixel(img, x, y, [200, 100, 50, 255]);
    const out = addOutlineRing(img, [1, 2, 3]);
    // interior untouched
    expect(getPixel(out, 4, 4)).toEqual([200, 100, 50, 255]);
    // ring pixel just outside the original silhouette
    expect(getPixel(out, 2, 4)).toEqual([1, 2, 3, 255]);
    // further out stays transparent
    expect(getPixel(out, 0, 4)[3]).toBe(0);
  });

  it("defaults the ink color to the darkest opaque color", () => {
    const img = makeImage(6, 6, [0, 0, 0, 0]);
    setPixel(img, 2, 2, [200, 200, 200, 255]);
    setPixel(img, 3, 2, [10, 10, 10, 255]);
    const out = addOutlineRing(img);
    expect(getPixel(out, 1, 2)).toEqual([10, 10, 10, 255]);
  });
});

describe("placeInCell", () => {
  it("centers horizontally and anchors to the floor with the given margin", () => {
    const img = makeImage(4, 6, [9, 9, 9, 255]);
    const out = placeInCell(img, { w: 20, h: 20 }, 2);
    expect(out.width).toBe(20);
    expect(out.height).toBe(20);
    // x centered: (20-4)/2 = 8; y: 20-2-6 = 12
    expect(getPixel(out, 8, 12)).toEqual([9, 9, 9, 255]);
    expect(getPixel(out, 7, 12)[3]).toBe(0);
    expect(getPixel(out, 8, 17)).toEqual([9, 9, 9, 255]); // last opaque row
    expect(getPixel(out, 8, 18)[3]).toBe(0); // floor margin
  });

  it("throws when the subject does not fit the cell", () => {
    const img = makeImage(30, 30, [1, 1, 1, 255]);
    expect(() => placeInCell(img, { w: 10, h: 10 })).toThrow();
  });
});

describe("convertSketch + verifySprite (end-to-end)", () => {
  it("turns a gapped pencil-sketch silhouette with a stray mark into a spec-legal sprite", () => {
    const src = sketchWithGap(3);
    // a stray mark (e.g. a signature) well clear of the drawing
    setPixel(src, 1, 38, [40, 40, 40, 255]);
    setPixel(src, 2, 38, [40, 40, 40, 255]);

    const result = convertSketch(src, { bridge: 3, blurRadiusFrac: 0.4 });
    const problems = verifySprite(result.image);
    expect(problems).toEqual([]);
    expect(result.image.width).toBe(CELL.w);
    expect(result.image.height).toBe(CELL.h);
    expect(result.palette.length).toBeLessThanOrEqual(8);
  });

  it("without bridging, the interior comes out hollow instead of filled (proving bridging is load-bearing)", () => {
    // verifySprite only checks spec geometry (size/alpha/colors/placement),
    // not silhouette topology, so a hollow ring can still pass it -- the
    // real, meaningful difference bridging makes is whether the drawing's
    // interior survives at all. Compare opaque pixel counts directly.
    const src = sketchWithGap(3);
    const bridged = convertSketch(src, { bridge: 3, blurRadiusFrac: 0.4 });
    const unbridged = convertSketch(src, { bridge: 0, blurRadiusFrac: 0.4 });
    const opaqueCount = (img: PixelBuffer) => {
      let n = 0;
      for (let p = 3; p < img.data.length; p += 4) if (img.data[p]) n++;
      return n;
    };
    // The bridged version keeps the whole filled interior; the unbridged
    // version keeps only the thin outline ring, which covers far fewer
    // pixels for the same silhouette.
    expect(opaqueCount(bridged.image)).toBeGreaterThan(opaqueCount(unbridged.image) * 2);
  });
});

describe("verifySprite", () => {
  function legalSprite(): PixelBuffer {
    const src = sketchWithGap(0);
    return convertSketch(src, { bridge: 2, blurRadiusFrac: 0.4 }).image;
  }

  it("passes a sprite produced by convertSketch", () => {
    expect(verifySprite(legalSprite())).toEqual([]);
  });

  it("flags the wrong cell size", () => {
    const img = makeImage(50, 50, [0, 0, 0, 0]);
    setPixel(img, 25, 25, [1, 1, 1, 255]);
    const problems = verifySprite(img, { cell: CELL });
    expect(problems.some((p) => p.includes("size is"))).toBe(true);
  });

  it("flags non-binary alpha", () => {
    const img = makeImage(CELL.w, CELL.h, [0, 0, 0, 0]);
    setPixel(img, 50, 50, [1, 1, 1, 130]);
    const problems = verifySprite(img);
    expect(problems.some((p) => p.includes("not binary"))).toBe(true);
  });

  it("flags no transparency at all", () => {
    const img = makeImage(CELL.w, CELL.h, [1, 1, 1, 255]);
    const problems = verifySprite(img);
    expect(problems.some((p) => p.includes("no transparency"))).toBe(true);
  });

  it("flags too many colors", () => {
    const img = makeImage(CELL.w, CELL.h, [0, 0, 0, 0]);
    for (let i = 0; i < 12; i++) setPixel(img, 10 + i, 10, [i * 20, i * 10, i * 5, 255]);
    const problems = verifySprite(img, { colors: 8 });
    expect(problems.some((p) => p.includes("colors, spec allows"))).toBe(true);
  });

  it("flags a subject floating above the floor", () => {
    const img = makeImage(CELL.w, CELL.h, [0, 0, 0, 0]);
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) setPixel(img, x + 10, y + 5, [1, 1, 1, 255]);
    const problems = verifySprite(img);
    expect(problems.some((p) => p.includes("floats"))).toBe(true);
  });

  it("flags a subject too small to read at battler scale", () => {
    const img = makeImage(CELL.w, CELL.h, [0, 0, 0, 0]);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setPixel(img, x + 45, y + CELL.h - 11, [1, 1, 1, 255]);
    const problems = verifySprite(img);
    expect(problems.some((p) => p.includes("longest side"))).toBe(true);
  });

  it("flags a subject off horizontal center", () => {
    const img = makeImage(CELL.w, CELL.h, [0, 0, 0, 0]);
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) setPixel(img, x, y + CELL.h - 51, [1, 1, 1, 255]);
    const problems = verifySprite(img);
    expect(problems.some((p) => p.includes("off horizontal center"))).toBe(true);
  });
});
