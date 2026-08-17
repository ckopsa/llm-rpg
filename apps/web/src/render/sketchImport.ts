/**
 * Sketch import: turn a photographed drawing into a spec-legal battler
 * sprite without leaving the app.
 *
 * This is a browser port of the two sprite-gen CLI tools, fused into one
 * pipeline rather than kept apart, because the browser use case is theirs
 * combined:
 *
 *   - `tools/sprite-gen/pixelize.py` is the acceptance spec. Its `convert`
 *     (background key -> isolate -> trim -> fit -> harden alpha -> quantize
 *     -> outline -> place) and `verify` (104x80 cell, binary alpha, <=8
 *     colors, standing on the floor, centered, longest side >= 46) are
 *     ported near-verbatim below as keyBackground/isolateSubject/trim/
 *     fitSubject/hardenAlpha/quantizeColors/addOutlineRing/placeInCell/
 *     verifySprite.
 *   - `tools/sprite-gen/sketch2sprite.py` targets the actual input this
 *     module receives -- a phone photo of a child's paper sketch, not a
 *     clean model render -- and its README documents two lessons pixelize
 *     alone does not know:
 *       1. "warm paper under uneven light flattens to white" -- illumination
 *          is divided out before anything else, so a shadow across the page
 *          does not get read as part of the drawing.
 *       2. "a six-year-old's outline is not a closed curve, and an outside
 *          flood leaks through it and fills the page" -- gaps are bridged
 *          with dilate -> fill(holes) -> erode instead of a bare corner
 *          flood, which is what pixelize.py's key_background does on its
 *          own and why it is not enough here.
 *
 * No DOM dependency in the pipeline itself: every function from
 * flattenIllumination through verifySprite operates on the DOM-free
 * PixelBuffer bag from ./recolor (same shape as ImageData), so the whole
 * conversion is unit-testable in Node exactly like recolor.ts. The two
 * functions that must touch a real <canvas> -- decoding an arbitrary photo
 * file's compressed bytes into raw pixels, and handing a finished
 * PixelBuffer back to the page as a displayable/downloadable image -- are
 * isolated at the bottom of the file and are not exercised by the test
 * suite (vitest here runs under plain Node, no jsdom/canvas).
 */
import { darkestColor, opaqueColors, type PixelBuffer } from "./recolor";

export type { PixelBuffer };

// Mirrors pixelize.py's CELL/SUBJECT/COLORS/FLOOR_MARGIN constants -- the
// battler spec itself, not a stylistic choice, so changing these means
// changing what apps/web/public/assets/battlers art looks like.
export const CELL = { w: 104, h: 80 };
export const SUBJECT = { w: 65, h: 55 };
export const COLORS = 8;
export const FLOOR_MARGIN = 1;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function makeBuffer(width: number, height: number): PixelBuffer {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

// ---------------------------------------------------------------------------
// 1D "distance to nearest set pixel" sweep -- the engine behind both the
// separable box blur (illumination flattening) and the separable square
// dilation/erosion (gap bridging, and the outline ring). Two O(n) passes
// per line beat a deque-based sliding window for readability here and cost
// nothing extra: the sizes involved (photo dimensions, then a downscaled
// ~55px subject) are small enough that big-O headroom is not the bottleneck.
// ---------------------------------------------------------------------------

function distanceToNearestSet1D(set: Uint8Array, out: Int32Array, n: number): void {
  const INF = n + 1;
  let last = -INF;
  for (let i = 0; i < n; i++) {
    if (set[i]) last = i;
    out[i] = i - last;
  }
  let next = 2 * INF;
  for (let i = n - 1; i >= 0; i--) {
    if (set[i]) next = i;
    const d = next - i;
    if (d < out[i]) out[i] = d;
  }
}

/** Square (Chebyshev) dilation by `radius`: separable horizontal + vertical
 *  "distance to nearest 1" sweep, thresholded at radius. Equivalent to
 *  repeatedly OR-ing in every mask pixel within a (2r+1)x(2r+1) box, which
 *  is exactly what PIL's ImageFilter.MaxFilter(3) does for radius 1 (the
 *  outline ring) and what sketch2sprite.py's disk dilation approximates for
 *  gap bridging (a square structuring element closes the same small gaps a
 *  circular one does; it is not worth a slower per-pixel circular version
 *  here). */
function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const rowDist = new Int32Array(width);
  const afterRows = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = mask.subarray(y * width, y * width + width);
    distanceToNearestSet1D(row, rowDist, width);
    for (let x = 0; x < width; x++) afterRows[y * width + x] = rowDist[x] <= radius ? 1 : 0;
  }
  const colDist = new Int32Array(height);
  const col = new Uint8Array(height);
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) col[y] = afterRows[y * width + x];
    distanceToNearestSet1D(col, colDist, height);
    for (let y = 0; y < height; y++) out[y * width + x] = colDist[y] <= radius ? 1 : 0;
  }
  return out;
}

/** Erosion is dilation of the complement, complemented again. */
function erodeMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const complement = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) complement[i] = mask[i] ? 0 : 1;
  const dilated = dilateMask(complement, width, height, radius);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) out[i] = dilated[i] ? 0 : 1;
  return out;
}

/** scipy.ndimage.binary_fill_holes: any 0-region of `mask` NOT reachable
 *  from the image border (by 4-connected steps through other 0s) is an
 *  enclosed hole and becomes 1. This is the "fill" in sketch2sprite.py's
 *  "dilate -> fill -> erode" -- it is what actually closes a gap, by
 *  reclassifying the interior the gap would otherwise have leaked into. */
function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const reached = new Uint8Array(width * height);
  const stack: number[] = [];
  const visit = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (reached[i] || mask[i]) return;
    reached[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i / width) | 0;
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] || !reached[i] ? 1 : 0;
  return out;
}

function boxBlur1D(src: Float32Array, out: Float32Array, n: number, radius: number): void {
  // Sliding-window sum via a running total, O(n) regardless of radius.
  let sum = 0;
  const window = 2 * radius + 1;
  for (let i = -radius; i <= radius; i++) sum += src[Math.min(n - 1, Math.max(0, i))];
  for (let i = 0; i < n; i++) {
    out[i] = sum / window;
    const add = src[Math.min(n - 1, i + radius + 1)];
    const drop = src[Math.max(0, i - radius)];
    sum += add - drop;
  }
}

function boxBlur2D(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const afterRows = new Float32Array(width * height);
  const rowIn = new Float32Array(width);
  const rowOut = new Float32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rowIn[x] = src[y * width + x];
    boxBlur1D(rowIn, rowOut, width, radius);
    for (let x = 0; x < width; x++) afterRows[y * width + x] = rowOut[x];
  }
  const out = new Float32Array(width * height);
  const colIn = new Float32Array(height);
  const colOut = new Float32Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) colIn[y] = afterRows[y * width + x];
    boxBlur1D(colIn, colOut, height, radius);
    for (let y = 0; y < height; y++) out[y * width + x] = colOut[y];
  }
  return out;
}

/**
 * Divide out uneven illumination before anything else touches the image.
 *
 * sketch2sprite.py's `extract`/`lineart` do this on the grayscale channel
 * only ("warm paper under uneven light flattens to white, only ink stays
 * dark") because that tool only ever reads darkness. This module also has
 * to handle drawings that are already colored in, so the same correction
 * factor (255 / locally-blurred luminance) is applied to all three RGB
 * channels together -- it flattens brightness while preserving hue, instead
 * of collapsing to grayscale.
 */
export function flattenIllumination(img: PixelBuffer, blurRadiusFrac = 0.05): PixelBuffer {
  const { width, height, data } = img;
  const radius = Math.max(4, Math.round(Math.min(width, height) * blurRadiusFrac));
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    lum[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }
  const blurred = boxBlur2D(lum, width, height, radius);
  const out = makeBuffer(width, height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    // sketch2sprite.py's `extract`/`lineart` target 255 unclamped, which is
    // correct for their case: thin ink on paper, so the LOCAL blur average
    // is dominated by paper almost everywhere and the factor stays close to
    // 1. This module also has to handle a drawing colored in solidly enough
    // to fill most of the frame, where the local blur average near the
    // center is the subject's OWN color, not paper under it -- an unclamped
    // factor there does not correct lighting, it bleaches the subject
    // toward white and erases the very contrast keyBackground needs.
    // Clamping to a modest band still corrects genuine (mild, smooth) photo
    // vignetting while leaving a saturated, frame-filling subject alone.
    const factor = Math.min(1.25, Math.max(0.8, 255 / Math.max(blurred[i], 1)));
    out.data[p] = clampByte(data[p] * factor);
    out.data[p + 1] = clampByte(data[p + 1] * factor);
    out.data[p + 2] = clampByte(data[p + 2] * factor);
    out.data[p + 3] = data[p + 3];
  }
  return out;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Estimate the background/paper color from the image's outer edge.
 *
 * pixelize.py samples the four corner pixels, which is fine for a clean
 * AI-generated background but not for a phone photo: the README's own
 * photograph tips ("leave margin... `--crop` warns if the drawing touches
 * the edge") exist because a real photo routinely has a thumb holding the
 * page in one corner. Averaging four single points means one bad corner
 * pulls the whole reference color toward it -- exactly what happened with
 * this module's own bundled test photo (`fufflehup.jpg` has a thumb in the
 * bottom-left corner, ~30 gray against ~195 paper elsewhere; a plain
 * 4-corner average sits at ~150, which then reads every paper pixel as
 * "ink" too). Sampling the whole perimeter and taking the per-channel
 * MEDIAN instead tolerates a badly-placed thumb (or spiral binding, or a
 * stray mark) covering a large minority of the border without moving the
 * estimate, as long as most of the edge is genuinely background -- which is
 * the same assumption the photography tips already ask for.
 */
function estimateBackgroundColor(img: PixelBuffer): [number, number, number] {
  const { width, height, data } = img;
  // Bound the sample for huge photos: every pixel of a multi-thousand-pixel
  // perimeter is unnecessary precision for a median estimate.
  const strideX = Math.max(1, Math.floor(width / 512));
  const strideY = Math.max(1, Math.floor(height / 512));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const sample = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  for (let x = 0; x < width; x += strideX) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += strideY) {
    sample(0, y);
    sample(width - 1, y);
  }
  return [median(rs), median(gs), median(bs)];
}

export interface KeyBackgroundOptions {
  /** Manhattan RGB distance from the estimated background color beyond
   *  which a pixel counts as "ink/subject". Same units as pixelize.py's
   *  `--tolerance`, but NOT the same default: pixelize.py's 24 is
   *  calibrated for a flat, noise-free AI-generated background, and is far
   *  too tight for a real phone photo of ruled notebook paper -- measured
   *  against this module's own bundled test photo, tolerance 24 reads
   *  ~47% of the ENTIRE page (paper grain, faint ruled lines, JPEG noise)
   *  as "ink", while 64 settles down to a clean, recognizable silhouette.
   *  Default here is 64 for that reason. */
  tolerance?: number;
  /** Gap-closing radius in source pixels -- sketch2sprite.py's `--bridge`.
   *  Closes gaps up to ~2*bridge px in the drawn outline. Defaults to ~1%
   *  of the image's shorter side, since a fixed pixel radius does not
   *  scale across a 964px scan and a 2867px phone photo the way a
   *  percentage does. */
  bridge?: number;
}

/**
 * Make the background transparent, robust to a hand-drawn outline that
 * never fully closes.
 *
 * pixelize.py's key_background floods in from the four corners and keys out
 * whatever it reaches -- correct for a flat AI-generated background, but a
 * flood fill leaks straight through any gap in a photographed pen line and
 * clears the whole page (see the sketch2sprite.py / README note this module
 * is built around). The fix, ported from sketch2sprite.py's `extract`, is
 * to dilate the candidate ink/subject mask first (closing small gaps),
 * flood the now-gap-free background from the border, then erode back to
 * the true edge position. A flood that cannot find a way in cannot leak.
 */
export function keyBackground(img: PixelBuffer, opts: KeyBackgroundOptions = {}): PixelBuffer {
  const { width, height, data } = img;
  const tolerance = opts.tolerance ?? 64;
  const bridge = opts.bridge ?? Math.max(2, Math.round(Math.min(width, height) * 0.01));

  const [r, g, b] = estimateBackgroundColor(img);

  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const dist = Math.abs(data[p] - r) + Math.abs(data[p + 1] - g) + Math.abs(data[p + 2] - b);
    ink[i] = dist > tolerance ? 1 : 0;
  }

  const dilated = dilateMask(ink, width, height, bridge);
  const filled = fillHoles(dilated, width, height);
  const subject = erodeMask(filled, width, height, bridge);

  const out = makeBuffer(width, height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    out.data[p] = data[p];
    out.data[p + 1] = data[p + 1];
    out.data[p + 2] = data[p + 2];
    out.data[p + 3] = subject[i] ? 255 : 0;
  }
  return out;
}

/**
 * Keep only the largest 4-connected opaque region (scipy.ndimage.label's
 * default connectivity, matching pixelize.py's isolate_subject).
 *
 * Speed lines, a spiral binding, a signature, a thumb holding the page --
 * all of it survives background keying as its own little island. Gap
 * bridging (above) closes small breaks WITHIN the subject's own outline; it
 * does nothing about marks that were never connected to the subject in the
 * first place. This drops them.
 */
export function isolateSubject(img: PixelBuffer): PixelBuffer {
  const { width, height, data } = img;
  const labels = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (labels[start] !== -1 || data[start * 4 + 3] === 0) continue;
    const label = sizes.length;
    labels[start] = label;
    let size = 0;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % width;
      const y = (i / width) | 0;
      const neighbors: [number, number][] = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (labels[ni] !== -1 || data[ni * 4 + 3] === 0) continue;
        labels[ni] = label;
        stack.push(ni);
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return { width, height, data: data.slice() };
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  const out = makeBuffer(width, height);
  out.data.set(data);
  for (let i = 0; i < width * height; i++) {
    if (labels[i] !== best) out.data[i * 4 + 3] = 0;
  }
  return out;
}

function boundingBox(img: PixelBuffer): Rect | null {
  const { width, height, data } = img;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Crop to the bounding box of opaque pixels (pixelize.py's _trim). Throws
 *  if the image is fully transparent, same as pixelize's SystemExit. */
export function trimToContent(img: PixelBuffer): PixelBuffer {
  const box = boundingBox(img);
  if (!box) throw new Error("sketchImport: image is fully transparent after background keying");
  const out = makeBuffer(box.w, box.h);
  for (let y = 0; y < box.h; y++) {
    const srcRow = ((box.y + y) * img.width + box.x) * 4;
    const dstRow = y * box.w * 4;
    out.data.set(img.data.subarray(srcRow, srcRow + box.w * 4), dstRow);
  }
  return out;
}

interface AxisWeights {
  index: number;
  weight: number;
}

function axisWeights(inSize: number, outSize: number): AxisWeights[][] {
  const scale = inSize / outSize;
  const table: AxisWeights[][] = [];
  for (let o = 0; o < outSize; o++) {
    const left = o * scale;
    const right = (o + 1) * scale;
    const lo = Math.max(0, Math.floor(left));
    const hi = Math.min(inSize - 1, Math.ceil(right) - 1);
    const entries: AxisWeights[] = [];
    for (let i = lo; i <= hi; i++) {
      const overlap = Math.min(right, i + 1) - Math.max(left, i);
      if (overlap > 0) entries.push({ index: i, weight: overlap });
    }
    if (entries.length === 0) entries.push({ index: Math.min(inSize - 1, lo), weight: 1 });
    table.push(entries);
  }
  return table;
}

/**
 * Area-average (box filter) resize, separable horizontal then vertical
 * pass, all four channels (R, G, B, A) independently. This is the pure-JS
 * equivalent of pixelize.py's `Image.Resampling.BOX`: every output pixel is
 * the weighted average of the input pixels it overlaps, which is what makes
 * downscaling smooth instead of dropping every other pixel the way nearest-
 * neighbor would (pixelize.py's doc comment on `_fit`: "nearest drops every
 * other pixel and shatters thin features"). No canvas involved -- this is
 * plain arithmetic over a PixelBuffer, which is what keeps it unit-testable.
 */
export function resizeAreaAverage(img: PixelBuffer, outWidth: number, outHeight: number): PixelBuffer {
  const { width, height, data } = img;
  outWidth = Math.max(1, Math.round(outWidth));
  outHeight = Math.max(1, Math.round(outHeight));
  const xWeights = axisWeights(width, outWidth);
  const horiz = new Float32Array(outWidth * height * 4);
  for (let y = 0; y < height; y++) {
    for (let ox = 0; ox < outWidth; ox++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      let ws = 0;
      for (const { index, weight } of xWeights[ox]) {
        const p = (y * width + index) * 4;
        rs += data[p] * weight;
        gs += data[p + 1] * weight;
        bs += data[p + 2] * weight;
        as += data[p + 3] * weight;
        ws += weight;
      }
      const q = (y * outWidth + ox) * 4;
      horiz[q] = rs / ws;
      horiz[q + 1] = gs / ws;
      horiz[q + 2] = bs / ws;
      horiz[q + 3] = as / ws;
    }
  }

  const yWeights = axisWeights(height, outHeight);
  const out = makeBuffer(outWidth, outHeight);
  for (let ox = 0; ox < outWidth; ox++) {
    for (let oy = 0; oy < outHeight; oy++) {
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      let ws = 0;
      for (const { index, weight } of yWeights[oy]) {
        const p = (index * outWidth + ox) * 4;
        rs += horiz[p] * weight;
        gs += horiz[p + 1] * weight;
        bs += horiz[p + 2] * weight;
        as += horiz[p + 3] * weight;
        ws += weight;
      }
      const q = (oy * outWidth + ox) * 4;
      out.data[q] = clampByte(rs / ws);
      out.data[q + 1] = clampByte(gs / ws);
      out.data[q + 2] = clampByte(bs / ws);
      out.data[q + 3] = clampByte(as / ws);
    }
  }
  return out;
}

/** Scale into `box` preserving aspect ratio (pixelize.py's _fit). */
export function fitSubject(img: PixelBuffer, box: { w: number; h: number }): PixelBuffer {
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  return resizeAreaAverage(img, w, h);
}

/** Snap alpha to 0/255 (pixelize.py's _harden_alpha). Averaging during
 *  resize leaves a soft edge; the renderer draws with smoothing off, so a
 *  soft edge would shimmer rather than blur -- this is what makes it not
 *  optional, same reasoning as pixelize.py's module docstring. */
export function hardenAlpha(img: PixelBuffer, threshold = 128): PixelBuffer {
  const out = makeBuffer(img.width, img.height);
  out.data.set(img.data);
  for (let p = 3; p < out.data.length; p += 4) {
    out.data[p] = out.data[p] >= threshold ? 255 : 0;
  }
  return out;
}

function colorDistSq(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Reduce the opaque palette to `colors` entries and remap every opaque
 * pixel through it. No dithering (pixelize.py disables it for the same
 * reason: at 2x with smoothing off, a dither pattern reads as noise, and it
 * would also inflate the color count past the spec).
 *
 * The selection method matters more than it looks, and this is the second
 * bug pixelize.py's docstring calls out by name: population-weighted
 * median-cut spends every slot on near-identical body tints and quantizes
 * away the one feature ("the EYES") a ~55px sprite cannot lose. Its fix is
 * MAXCOVERAGE, a Pillow-specific variant. There is no equivalent library
 * call available here, so this ports the same idea with an explicit,
 * dependency-free algorithm: greedy farthest-point sampling (a.k.a. greedy
 * k-center / max-min sampling) over the distinct opaque colors. Start from
 * the most common color, then repeatedly add whichever remaining color has
 * the largest *minimum* distance to every color already chosen. A cluster
 * of near-duplicate body tints all sit close together in RGB space, so
 * after the first one is picked the rest have a small min-distance and lose
 * out; a small, saturated, far-away cluster like an eye or a highlight has
 * a large min-distance and gets picked specifically because it is
 * different from everything else, regardless of how few pixels it covers.
 * That is a direct, mechanical analog of "keeps outliers" -- MAXCOVERAGE's
 * documented reason for existing.
 *
 * One risk unique to a photographed source that a clean render does not
 * have: JPEG noise and anti-aliased edge blending can leave a handful of
 * one-off colors that are colorimetrically "distinct" but visually
 * meaningless. Farthest-point sampling would happily burn a palette slot on
 * a single noisy pixel. To avoid that, colors covering fewer than ~0.1% of
 * the opaque area (floor of 2px) are excluded from *candidacy* for a
 * palette slot -- but every pixel, noisy or not, still gets remapped to
 * its nearest surviving palette color in the final pass, so no pixel is
 * ever dropped, just never allowed to define a slot on its own.
 */
export function quantizeColors(img: PixelBuffer, colors: number): PixelBuffer {
  const counted = opaqueColors(img);
  if (counted.length === 0) return { width: img.width, height: img.height, data: img.data.slice() };
  if (counted.length <= colors) {
    return remapToPalette(img, counted.map((c) => c.rgb));
  }

  const totalOpaque = counted.reduce((sum, c) => sum + c.count, 0);
  const noiseFloor = Math.max(2, Math.round(totalOpaque * 0.001));
  const candidates = counted.filter((c) => c.count >= noiseFloor);
  const pool = candidates.length > 0 ? candidates : counted;

  const chosen: [number, number, number][] = [pool[0].rgb];
  const minDist = pool.map((c) => colorDistSq(c.rgb, chosen[0]));
  while (chosen.length < colors && chosen.length < pool.length) {
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      if (minDist[i] > bestScore) {
        bestScore = minDist[i];
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || bestScore <= 0) break;
    chosen.push(pool[bestIdx].rgb);
    for (let i = 0; i < pool.length; i++) {
      const d = colorDistSq(pool[i].rgb, pool[bestIdx].rgb);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  return remapToPalette(img, chosen);
}

function remapToPalette(img: PixelBuffer, palette: [number, number, number][]): PixelBuffer {
  const out = makeBuffer(img.width, img.height);
  const cache = new Map<number, [number, number, number]>();
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out.data[i + 3] = a;
    if (a === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let mapped = cache.get(key);
    if (!mapped) {
      const src: [number, number, number] = [data[i], data[i + 1], data[i + 2]];
      let best = palette[0];
      let bestDist = Infinity;
      for (const candidate of palette) {
        const d = colorDistSq(src, candidate);
        if (d < bestDist) {
          bestDist = d;
          best = candidate;
        }
      }
      mapped = best;
      cache.set(key, mapped);
    }
    out.data[i] = mapped[0];
    out.data[i + 1] = mapped[1];
    out.data[i + 2] = mapped[2];
  }
  return out;
}

/**
 * Wrap the subject in a 1px outline ring (pixelize.py's _outline), drawn
 * OUTSIDE the existing silhouette so it never eats into a subject that may
 * already be only ~55px wide. Dilation radius 1 with a square structuring
 * element is exactly PIL's ImageFilter.MaxFilter(3).
 */
export function addOutlineRing(img: PixelBuffer, ink?: [number, number, number]): PixelBuffer {
  const { width, height, data } = img;
  const alpha = new Uint8Array(width * height);
  for (let i = 0, p = 3; i < width * height; i++, p += 4) alpha[i] = data[p] ? 1 : 0;
  const grown = dilateMask(alpha, width, height, 1);
  const inkColor = ink ?? darkestColor(img);
  if (!inkColor) return { width, height, data: data.slice() };

  const out = makeBuffer(width, height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (alpha[i]) {
      out.data[p] = data[p];
      out.data[p + 1] = data[p + 1];
      out.data[p + 2] = data[p + 2];
      out.data[p + 3] = 255;
    } else if (grown[i]) {
      out.data[p] = inkColor[0];
      out.data[p + 1] = inkColor[1];
      out.data[p + 2] = inkColor[2];
      out.data[p + 3] = 255;
    }
  }
  return out;
}

/** Bottom-anchored, horizontally centered placement into the cell
 *  (pixelize.py's _place). Throws if the subject does not fit, same as
 *  pixelize's SystemExit -- a caller should never reach this with a subject
 *  larger than SUBJECT if fitSubject ran first. */
export function placeInCell(img: PixelBuffer, cell: { w: number; h: number }, floorMargin = FLOOR_MARGIN): PixelBuffer {
  if (img.width > cell.w || img.height > cell.h) {
    throw new Error(`sketchImport: subject ${img.width}x${img.height} does not fit cell ${cell.w}x${cell.h}`);
  }
  const out = makeBuffer(cell.w, cell.h);
  const x = Math.floor((cell.w - img.width) / 2);
  const y = cell.h - floorMargin - img.height;
  for (let row = 0; row < img.height; row++) {
    const srcOff = row * img.width * 4;
    const dstOff = ((y + row) * cell.w + x) * 4;
    out.data.set(img.data.subarray(srcOff, srcOff + img.width * 4), dstOff);
  }
  return out;
}

export interface SketchImportOptions {
  colors?: number;
  subject?: { w: number; h: number };
  cell?: { w: number; h: number };
  tolerance?: number;
  bridge?: number;
  blurRadiusFrac?: number;
  alphaThreshold?: number;
  floorMargin?: number;
  outline?: [number, number, number];
  addOutline?: boolean;
  /** Drop everything not connected to the main silhouette (speed lines, a
   *  thumb, a signature). Defaults to true: unlike pixelize.py (whose
   *  --isolate defaults off because a clean AI render rarely needs it), a
   *  photographed sketch routinely has stray marks. */
  isolate?: boolean;
  /** Divide out uneven photo lighting before keying the background.
   *  Defaults to true; set false for art that is already flat and clean
   *  (a scan, or a digitally colored piece) where it is just wasted work. */
  flattenIlluminationFirst?: boolean;
}

export interface ConvertResult {
  image: PixelBuffer;
  palette: [number, number, number][];
  subjectBox: Rect;
  floorGap: number;
}

/**
 * The full sketch-to-sprite pipeline: photographed drawing in, spec-legal
 * 104x80 battler PixelBuffer out. Mirrors pixelize.py's `convert()` stage
 * order, with the illumination and gap-bridging steps from sketch2sprite.py
 * folded in at the front (see the module docstring for why both tools are
 * needed).
 */
export function convertSketch(src: PixelBuffer, options: SketchImportOptions = {}): ConvertResult {
  const colors = options.colors ?? COLORS;
  const subject = options.subject ?? SUBJECT;
  const cell = options.cell ?? CELL;
  const addOutline = options.addOutline ?? true;
  const isolate = options.isolate ?? true;
  const flatten = options.flattenIlluminationFirst ?? true;
  const floorMargin = options.floorMargin ?? FLOOR_MARGIN;
  const alphaThreshold = options.alphaThreshold ?? 128;

  let img = flatten ? flattenIllumination(src, options.blurRadiusFrac ?? 0.05) : src;
  img = keyBackground(img, { tolerance: options.tolerance, bridge: options.bridge });
  if (isolate) img = isolateSubject(img);
  img = trimToContent(img);

  const fitBox = addOutline ? { w: subject.w - 2, h: subject.h - 2 } : subject;
  img = fitSubject(img, fitBox);
  img = hardenAlpha(img, alphaThreshold);
  img = trimToContent(img);
  img = quantizeColors(img, addOutline ? colors - 1 : colors);
  if (addOutline) img = addOutlineRing(img, options.outline);
  img = placeInCell(img, cell, floorMargin);

  const box = boundingBox(img)!;
  return {
    image: img,
    palette: opaqueColors(img).map((c) => c.rgb),
    subjectBox: box,
    floorGap: cell.h - (box.y + box.h),
  };
}

/**
 * Port of pixelize.py's `verify()` -- the battler spec's acceptance
 * criteria, not just a sanity check. Empty array means the sprite is legal.
 */
export function verifySprite(
  img: PixelBuffer,
  options: { colors?: number; cell?: { w: number; h: number } } = {},
): string[] {
  const colors = options.colors ?? COLORS;
  const cell = options.cell ?? CELL;
  const problems: string[] = [];

  if (img.width !== cell.w || img.height !== cell.h) {
    problems.push(`size is ${img.width}x${img.height}, expected ${cell.w}x${cell.h}`);
  }

  const alphaValues = new Set<number>();
  for (let p = 3; p < img.data.length; p += 4) alphaValues.add(img.data[p]);
  const stray = [...alphaValues].filter((v) => v !== 0 && v !== 255);
  if (stray.length > 0) {
    problems.push(
      `alpha is not binary: ${stray.length} intermediate value(s) e.g. ${stray.slice(0, 4).sort((a, b) => a - b).join(",")} -- the renderer draws with smoothing off, so these shimmer`,
    );
  }
  if (alphaValues.size === 1 && alphaValues.has(255)) {
    problems.push("no transparency at all: the background was never keyed out");
  }

  const palette = opaqueColors(img);
  if (palette.length > colors) {
    problems.push(`${palette.length} colors, spec allows ${colors} (the pack uses 5-13)`);
  }

  const box = boundingBox(img);
  if (!box) {
    problems.push("fully transparent");
    return problems;
  }

  const floorGap = cell.h - (box.y + box.h);
  if (floorGap > 3) {
    problems.push(`subject floats ${floorGap}px above the cell floor; battlers stand on it (gap 1-2)`);
  }
  if (box.w > cell.w || box.h > cell.h) {
    problems.push(`subject is ${box.w}x${box.h}, larger than the ${cell.w}x${cell.h} cell`);
  } else if (Math.max(box.w, box.h) < 46) {
    problems.push(
      `subject is ${box.w}x${box.h}; its longest side should reach ~46+ to sit alongside the pack (which ranges 55x46 to 98x70) instead of looking like a distant speck`,
    );
  }

  const centerOff = Math.abs((box.x + box.w / 2) - cell.w / 2);
  if (centerOff > 6) {
    problems.push(`subject is ${Math.round(centerOff)}px off horizontal center`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Canvas boundary. Everything above this line is plain PixelBuffer
// arithmetic and is what the test suite exercises. Below is the only place
// a real <canvas> is genuinely required: decoding a photographed image
// file's compressed bytes (JPEG/PNG/whatever the camera produced) into raw
// pixels, and the reverse for showing/saving a finished sprite. There is no
// dependency-free way to decode an arbitrary photo format in pure JS, and
// this repo does not carry an image-decoding library -- the browser's own
// decoder, reached through canvas, is the only option. Neither function is
// covered by the unit tests (vitest runs under plain Node here, no
// jsdom/canvas), so keep them thin and push all real logic above the line.
// ---------------------------------------------------------------------------

/** Decode an image file (e.g. from an <input type="file"> or a camera
 *  capture) into a PixelBuffer, via an offscreen canvas. Browser-only. */
export async function decodeImageFile(file: Blob): Promise<PixelBuffer> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("sketchImport: 2d canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: imageData.width, height: imageData.height, data: imageData.data };
  } finally {
    bitmap.close();
  }
}

/** Render a finished PixelBuffer to a canvas element, for on-page preview
 *  or for `canvas.toBlob(...)` to let the player save the PNG. Browser-only. */
export function pixelBufferToCanvas(img: PixelBuffer): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("sketchImport: 2d canvas context unavailable");
  const imageData = ctx.createImageData(img.width, img.height);
  imageData.data.set(img.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
