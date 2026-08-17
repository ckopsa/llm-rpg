import { describe, expect, it } from "vitest";
import { darkestColor, opaqueColors, recolorSprite, type PixelBuffer } from "./recolor";

/** Build a tiny synthetic sprite: a 4x4 opaque body (2 colors) with a 1px
 *  dark outline ring, sitting in an 8x6 transparent cell — small enough to
 *  reason about by hand, shaped like a real battler (outline + body colors
 *  + transparent floor). */
function fixtureSprite(): PixelBuffer {
  const width = 8;
  const height = 6;
  const data = new Uint8ClampedArray(width * height * 4);
  const OUTLINE: [number, number, number] = [20, 20, 20];
  const BODY_A: [number, number, number] = [200, 60, 60]; // red-ish
  const BODY_B: [number, number, number] = [60, 120, 200]; // blue-ish

  // rows 1..4, cols 2..5: outline ring at the border of that box, body inside
  const set = (x: number, y: number, rgb: [number, number, number]) => {
    const i = (y * width + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  };

  for (let y = 1; y <= 4; y++) {
    for (let x = 2; x <= 5; x++) {
      const isRing = x === 2 || x === 5 || y === 1 || y === 4;
      set(x, y, isRing ? OUTLINE : x < 4 ? BODY_A : BODY_B);
    }
  }
  return { width, height, data };
}

function alphaMask(img: PixelBuffer): number[] {
  const mask: number[] = [];
  for (let i = 0; i < img.data.length; i += 4) mask.push(img.data[i + 3]);
  return mask;
}

function boundingBox(img: PixelBuffer): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3];
      if (a === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

describe("recolorSprite", () => {
  it("identifies the darkest opaque color as the outline", () => {
    const sprite = fixtureSprite();
    expect(darkestColor(sprite)).toEqual([20, 20, 20]);
  });

  it("never increases the opaque color count", () => {
    const sprite = fixtureSprite();
    const before = opaqueColors(sprite).length;
    expect(before).toBeLessThanOrEqual(8);
    const out = recolorSprite(sprite, { hueRotateDeg: 120, saturationDelta: 0.2, lightnessDelta: -0.1 });
    const after = opaqueColors(out).length;
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeLessThanOrEqual(8);
  });

  it("keeps alpha binary and unchanged per-pixel", () => {
    const sprite = fixtureSprite();
    const before = alphaMask(sprite);
    const out = recolorSprite(sprite, { hueRotateDeg: 200, saturationDelta: 0.5, lightnessDelta: 0.3 });
    const after = alphaMask(out);
    expect(after).toEqual(before);
    for (const a of after) expect(a === 0 || a === 255).toBe(true);
  });

  it("preserves the silhouette: identical alpha mask and bounding box", () => {
    const sprite = fixtureSprite();
    const out = recolorSprite(sprite, { hueRotateDeg: 45, saturationDelta: -0.3, lightnessDelta: 0.15 });
    expect(alphaMask(out)).toEqual(alphaMask(sprite));
    expect(boundingBox(out)).toEqual(boundingBox(sprite));
  });

  it("never tints fully transparent pixels", () => {
    const sprite = fixtureSprite();
    const out = recolorSprite(sprite, { hueRotateDeg: 90, saturationDelta: 1, lightnessDelta: 1 });
    for (let i = 0; i < sprite.data.length; i += 4) {
      if (sprite.data[i + 3] === 0) {
        expect([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]]).toEqual([0, 0, 0, 0]);
      }
    }
  });

  it("by default leaves the outline color exactly as it was", () => {
    const sprite = fixtureSprite();
    const out = recolorSprite(sprite, { hueRotateDeg: 180, saturationDelta: 0.9, lightnessDelta: -0.5 });
    // top-left ring pixel of the box is outline at (2,1)
    const i = (1 * sprite.width + 2) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([20, 20, 20]);
  });

  it("keepOutline: false shifts the outline too", () => {
    const sprite = fixtureSprite();
    const out = recolorSprite(sprite, { hueRotateDeg: 180, saturationDelta: 0.9, lightnessDelta: 0.4, keepOutline: false });
    const i = (1 * sprite.width + 2) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2]]).not.toEqual([20, 20, 20]);
  });

  it("a zero transform is a near-identity (outline kept, body colors round-trip)", () => {
    const sprite = fixtureSprite();
    const out = recolorSprite(sprite, {});
    // Every original color should still be present with the same footprint,
    // since HSL->RGB->HSL round-trips exactly for exact-integer inputs here.
    expect(new Set(opaqueColors(out).map((c) => c.rgb.join(",")))).toEqual(
      new Set(opaqueColors(sprite).map((c) => c.rgb.join(","))),
    );
  });

  it("hue rotation actually changes non-outline body colors", () => {
    const sprite = fixtureSprite();
    const out = recolorSprite(sprite, { hueRotateDeg: 90 });
    // body A pixel at (3,2) should no longer be red-ish [200,60,60]
    const i = (2 * sprite.width + 3) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2]]).not.toEqual([200, 60, 60]);
  });
});
