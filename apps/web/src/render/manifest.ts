/**
 * Sprite manifest schema + loader.
 *
 * A manifest maps logical sprite ids to spritesheet regions and animations:
 *
 *   sheets:  { [sheetId]: { src, tileW, tileH } }
 *   sprites: { [spriteId]: { sheet, anims: { [animName]: { frames: [col,row][], fps } } } }
 *
 * A static sprite is a 1-frame anim named "idle". Character sprites use the
 * anim names idle_north/south/east/west and walk_north/south/east/west.
 *
 * This module is deliberately engine-free: it takes plain JSON and DOM images.
 */
import { z } from "zod";

export const FrameSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

export const AnimSchema = z.object({
  /** Frame cells as [col, row] into the sheet's tile grid. */
  frames: z.array(FrameSchema).min(1),
  /** Frames per second; a 1-frame anim may use any positive value. */
  fps: z.number().positive(),
});

export const SheetSchema = z.object({
  /** Image URL (served from /assets/...). */
  src: z.string().min(1),
  tileW: z.number().int().positive(),
  tileH: z.number().int().positive(),
});

export const SpriteSchema = z.object({
  /** Id of an entry in `sheets`. */
  sheet: z.string().min(1),
  anims: z.record(AnimSchema),
});

export const ManifestSchema = z.object({
  sheets: z.record(SheetSchema),
  sprites: z.record(SpriteSchema),
});

export type Frame = z.infer<typeof FrameSchema>;
export type Anim = z.infer<typeof AnimSchema>;
export type SheetDef = z.infer<typeof SheetSchema>;
export type SpriteDef = z.infer<typeof SpriteSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export interface LoadedSheet {
  def: SheetDef;
  image: HTMLImageElement;
  /** Grid dimensions derived from the loaded image. */
  cols: number;
  rows: number;
}

export interface LoadedManifest {
  manifest: Manifest;
  sheets: Map<string, LoadedSheet>;
}

/**
 * Parse and structurally validate manifest JSON, including cross-references
 * (every sprite must point at a declared sheet). Throws Error with an
 * actionable message on failure.
 */
export function parseManifest(data: unknown): Manifest {
  const result = ManifestSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  at ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Sprite manifest failed schema validation:\n${issues}`);
  }
  const manifest = result.data;
  const sheetIds = Object.keys(manifest.sheets);
  for (const [spriteId, sprite] of Object.entries(manifest.sprites)) {
    if (!manifest.sheets[sprite.sheet]) {
      throw new Error(
        `Sprite "${spriteId}" references unknown sheet "${sprite.sheet}". ` +
          `Declared sheets: ${sheetIds.join(", ")}`,
      );
    }
  }
  return manifest;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`Failed to load sheet image "${src}" (missing file or bad path?)`));
    img.src = src;
  });
}

/**
 * Validate frame coordinates against the actual image dimensions (only
 * knowable after image load). Throws with the offending sprite/anim/frame.
 */
export function validateFrameBounds(
  manifest: Manifest,
  sheets: Map<string, LoadedSheet>,
): void {
  for (const [spriteId, sprite] of Object.entries(manifest.sprites)) {
    const sheet = sheets.get(sprite.sheet)!;
    for (const [animName, anim] of Object.entries(sprite.anims)) {
      anim.frames.forEach(([col, row], i) => {
        if (col >= sheet.cols || row >= sheet.rows) {
          throw new Error(
            `Sprite "${spriteId}" anim "${animName}" frame ${i} is [${col},${row}], ` +
              `but sheet "${sprite.sheet}" (${sheet.image.naturalWidth}x${sheet.image.naturalHeight}, ` +
              `${sheet.def.tileW}x${sheet.def.tileH} tiles) only has ` +
              `${sheet.cols}x${sheet.rows} cells (max [${sheet.cols - 1},${sheet.rows - 1}])`,
          );
        }
      });
    }
  }
}

/** Fetch manifest JSON, validate it, load all sheet images, check bounds. */
export async function loadManifest(url: string): Promise<LoadedManifest> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch sprite manifest "${url}": HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Sprite manifest "${url}" is not valid JSON: ${String(e)}`);
  }
  const manifest = parseManifest(json);

  const sheets = new Map<string, LoadedSheet>();
  await Promise.all(
    Object.entries(manifest.sheets).map(async ([id, def]) => {
      const image = await loadImage(def.src);
      if (image.naturalWidth % def.tileW !== 0 || image.naturalHeight % def.tileH !== 0) {
        console.warn(
          `Sheet "${id}" (${image.naturalWidth}x${image.naturalHeight}) is not an exact ` +
            `multiple of its ${def.tileW}x${def.tileH} tile size; trailing pixels are ignored.`,
        );
      }
      sheets.set(id, {
        def,
        image,
        cols: Math.floor(image.naturalWidth / def.tileW),
        rows: Math.floor(image.naturalHeight / def.tileH),
      });
    }),
  );

  validateFrameBounds(manifest, sheets);
  return { manifest, sheets };
}
