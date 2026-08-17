/**
 * Pure sprite recolor: palette-shift a battler so a child can make a
 * bundled sprite "theirs" with a hue/saturation/lightness nudge and zero
 * art skill.
 *
 * The battler spec (tools/sprite-gen/pixelize.py) is what keeps sprites
 * crisp at 2x with imageSmoothingEnabled=false: <=8 opaque colors and
 * BINARY alpha (0 or 255). A naive per-pixel HSL shift on antialiased art
 * would be safe, but our art has none of that — it is already flat-shaded
 * to a handful of colors, so shifting per-pixel would just recompute the
 * same handful of outputs 100x80 times AND risks floating point rounding
 * splitting one source color into two adjacent output colors (banding,
 * and a palette that quietly grows past 8). Recoloring the PALETTE and
 * remapping every pixel through it sidesteps both problems: the output
 * palette size can only stay the same or shrink (two colors landing on
 * the same output tint), never grow, and every pixel that shared a color
 * before still shares one after.
 *
 * No DOM dependency: this operates on a plain { width, height, data }
 * bag shaped like ImageData (Uint8ClampedArray, RGBA, row-major) so it is
 * unit-testable in Node and also accepts a real ImageData untouched.
 */

/** Structurally compatible with the DOM's ImageData — accepts either. */
export interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, 4 bytes per pixel — same layout as ImageData.data. */
  readonly data: Uint8ClampedArray;
}

export interface RecolorTransform {
  /** Degrees to rotate hue by, any real number (wraps mod 360). Default 0. */
  hueRotateDeg?: number;
  /** Additive nudge to saturation, roughly -1..1, clamped to 0..1 after. Default 0. */
  saturationDelta?: number;
  /** Additive nudge to lightness, roughly -1..1, clamped to 0..1 after. Default 0. */
  lightnessDelta?: number;
  /**
   * Leave the outline/ink color untouched instead of recoloring it too.
   * Default true — see recolorSprite's doc comment for why.
   */
  keepOutline?: boolean;
}

interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

function packRgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hueToRgbChannel(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb(hsl: Hsl): [number, number, number] {
  const { s, l } = hsl;
  const h = ((hsl.h % 360) + 360) % 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = h / 360;
  const r = hueToRgbChannel(p, q, hn + 1 / 3);
  const g = hueToRgbChannel(p, q, hn);
  const b = hueToRgbChannel(p, q, hn - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** [(rgb, opaque pixel count)] over a buffer, most common first — mirrors
 *  pixelize.py's _opaque_colors so the two tools agree on "the palette". */
export function opaqueColors(img: PixelBuffer): { rgb: [number, number, number]; count: number }[] {
  const counts = new Map<number, number>();
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const key = packRgb(data[i], data[i + 1], data[i + 2]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ rgb: [(key >> 16) & 255, (key >> 8) & 255, key & 255] as [number, number, number], count }))
    .sort((a, b) => b.count - a.count);
}

/** The darkest opaque color by perceptual luminance — the pack's ink line.
 *  Same weighting pixelize.py's _darkest uses, so both tools agree on which
 *  palette entry is "the outline". Returns null for a fully transparent image. */
export function darkestColor(img: PixelBuffer): [number, number, number] | null {
  const colors = opaqueColors(img);
  if (colors.length === 0) return null;
  let best = colors[0].rgb;
  let bestLum = Infinity;
  for (const { rgb } of colors) {
    const lum = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
    if (lum < bestLum) {
      bestLum = lum;
      best = rgb;
    }
  }
  return best;
}

/**
 * Recolor a battler by shifting its (<=8 color) palette in HSL space and
 * remapping every opaque pixel through the shifted palette.
 *
 * Why keepOutline defaults to true: the pack's dark ink outline is what
 * makes a ~55-98px sprite read as a creature at 2x instead of a blob — it
 * is drawn as a deliberately separate ring in pixelize.py's _outline(),
 * not "the darkest body color that happens to look dark". Hue-rotating it
 * along with everything else routinely drags it toward mid-tone (e.g. a
 * saturation/lightness nudge meant to warm up a body color would just as
 * happily wash out the line that separates the sprite from the felt-tip
 * background). A child playing with a slider wants "make it purple", not
 * "make the outline part of the puzzle too" — so by default the darkest
 * opaque color (same heuristic as pixelize.py's _darkest) is identified
 * and left untouched, and every other palette entry is shifted. Setting
 * keepOutline: false shifts it too, for callers who want a monochrome/sepia
 * silhouette effect instead of a recolor.
 */
export function recolorSprite(img: PixelBuffer, transform: RecolorTransform): PixelBuffer {
  const hueRotateDeg = transform.hueRotateDeg ?? 0;
  const saturationDelta = transform.saturationDelta ?? 0;
  const lightnessDelta = transform.lightnessDelta ?? 0;
  const keepOutline = transform.keepOutline ?? true;

  const outline = keepOutline ? darkestColor(img) : null;
  const outlineKey = outline ? packRgb(...outline) : null;

  const remap = new Map<number, [number, number, number]>();
  for (const { rgb } of opaqueColors(img)) {
    const key = packRgb(...rgb);
    if (outlineKey !== null && key === outlineKey) {
      remap.set(key, rgb);
      continue;
    }
    const hsl = rgbToHsl(...rgb);
    hsl.h += hueRotateDeg;
    hsl.s = clamp01(hsl.s + saturationDelta);
    hsl.l = clamp01(hsl.l + lightnessDelta);
    remap.set(key, hslToRgb(hsl));
  }

  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    out[i + 3] = a; // alpha untouched — binary in, binary out, never tinted
    if (a === 0) continue; // fully transparent pixels stay exactly as they were
    const key = packRgb(src[i], src[i + 1], src[i + 2]);
    const mapped = remap.get(key) ?? [src[i], src[i + 1], src[i + 2]];
    out[i] = mapped[0];
    out[i + 1] = mapped[1];
    out[i + 2] = mapped[2];
  }

  return { width: img.width, height: img.height, data: out };
}
