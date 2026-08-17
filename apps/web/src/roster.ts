/**
 * Browser roster: a child's saved creatures, persisted in localStorage and
 * layered onto the running game.
 *
 * A "roster" is the small document defined by `RosterSchema` in the engine
 * (packages/engine/src/roster.ts) — one or more hand-designed species plus
 * where each is found. `applyRoster` there is pure and already does the
 * hard part (balance checks, catalog cross-references, encounter-table
 * wiring); this module only adds the two things a browser needs on top:
 *
 *  1. Storage. Same discipline as saves.ts: keys are namespaced per gameId
 *     (`llmrpg:roster:<gameId>`), and corrupt or foreign data NEVER throws
 *     out of this module — every read/write returns a tagged result the UI
 *     can describe gently.
 *
 *  2. Art. `applyRoster` attaches a `spriteDataUrl` onto the generated
 *     species object, but a `validateGame` round trip STRIPS it — zod drops
 *     unknown keys, and `SpeciesSchema` has no such field (verified; see
 *     llm-rpg-v4i.5's notes). The web renderer never reads art off the
 *     species object anyway: `BattleView.drawBattler` resolves a battler
 *     sprite via `SpriteMap.speciesSprite(speciesId)`, which is built from
 *     games/<id>/sprites.json keyed by species id. So a roster creature's
 *     art has to travel as a SPRITE-MAP overlay instead: `applyRosterSprites`
 *     decodes each entry's data URL into a real image, registers it as a
 *     one-frame "idle" sprite directly on the loaded manifest (the same
 *     object `loadManifest` produces — `resolveAsset` in manifest.ts already
 *     passes `data:` URLs through unchanged, so this is a supported shape,
 *     not a hack), and returns a `speciesId -> spriteId` map that the caller
 *     merges into its sprites.json document (`mergeRosterSprites`) before
 *     calling `loadSpriteMap` once. A creature with no sprite — or one whose
 *     image fails to decode — simply gets no entry in that map, and
 *     `SpriteMap.speciesSprite` returning null is already handled by
 *     `drawBattler`: it falls back to the species' emoji glyph. Nothing new
 *     to build there; this layer just has to not interfere with it.
 *
 * `loadRosterOverlay` ties storage + `applyRoster` + a `validateGame`
 * round trip together the same way main.ts already applies a `?lang=`
 * overlay: on ANY problem (missing catalog, a bad entry, an overlay that
 * fails revalidation) the shipped game comes back untouched, and the
 * reason is reported rather than swallowed.
 */
import { applyRoster, validateGame, RosterSchema, type Game, type Roster } from "@llm-rpg/engine";
import type { LoadedManifest, LoadedSheet } from "./render/manifest";

// ---- storage --------------------------------------------------------------

const key = (gameId: string) => `llmrpg:roster:${gameId}`;

/** Stored value: the roster document plus a timestamp. */
interface StoredRoster {
  savedAt: string;
  roster: unknown;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage disabled (privacy mode etc.) — the roster just vanishes
  }
}

export type RosterReadResult =
  | { ok: true; roster: Roster; savedAt?: string }
  | { ok: false; empty: true; error: string }
  | { ok: false; empty?: false; error: string };

/** Read gameId's saved roster. Corruption and foreign shapes come back as
 *  gentle tagged errors; nothing ever throws. */
export function readRoster(gameId: string): RosterReadResult {
  const store = storage();
  const raw = store?.getItem(key(gameId));
  if (!raw) return { ok: false, empty: true, error: "No roster saved yet." };
  try {
    const stored = JSON.parse(raw) as Partial<StoredRoster>;
    const parsed = RosterSchema.safeParse(stored.roster);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `Saved roster is damaged (${issues}).` };
    }
    return {
      ok: true,
      roster: parsed.data,
      savedAt: typeof stored.savedAt === "string" ? stored.savedAt : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      error: `Saved roster couldn't be read (${e instanceof Error ? e.message : String(e)}).`,
    };
  }
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/** Save a roster for gameId, replacing any previous one. */
export function writeRoster(gameId: string, roster: Roster): WriteResult {
  const store = storage();
  if (!store) return { ok: false, error: "This browser is not letting the game keep a roster." };
  const parsed = RosterSchema.safeParse(roster);
  if (!parsed.success) {
    return { ok: false, error: "That roster isn't valid — nothing was saved." };
  }
  try {
    const stored: StoredRoster = { savedAt: new Date().toISOString(), roster: parsed.data };
    store.setItem(key(gameId), JSON.stringify(stored));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not save the roster: ${String(e)}` };
  }
}

/** Drop gameId's saved roster, if any. Never throws. */
export function clearRoster(gameId: string): void {
  try {
    storage()?.removeItem(key(gameId));
  } catch {
    /* storage disabled — nothing to clear */
  }
}

export function hasRoster(gameId: string): boolean {
  return readRoster(gameId).ok;
}

// ---- applying to the game document ----------------------------------------

export interface RosterApplyResult {
  /** The game to use — the overlaid game when `applied`, else `game`
   *  exactly as passed in (never mutated). */
  game: Game;
  applied: boolean;
  /** Non-empty only when `applied` is false; each names the fix. */
  errors: string[];
  /** Non-fatal notes from the engine's own `applyRoster` (e.g. an
   *  encounter zone created on a map with no wild tiles yet). Present
   *  whether or not the overlay ultimately validated. */
  warnings: string[];
}

/**
 * Layer `roster` onto `game`: engine `applyRoster`, then a `validateGame`
 * round trip through JSON — exactly the pattern main.ts already uses for
 * `?lang=` overlays. That round trip both confirms the result is a legal
 * game AND is where a roster entry's `spriteDataUrl` gets stripped from its
 * species object (zod drops unknown keys) — the reason art has to travel
 * through `applyRosterSprites` instead of riding along on the game object.
 *
 * If EITHER step reports a problem (any entry rejected, or the overlaid
 * game fails to revalidate) the original `game` comes back unchanged and
 * `applied` is false — a broken roster never partially applies and never
 * makes the game unplayable.
 */
export function applyStoredRoster(game: Game, roster: Roster): RosterApplyResult {
  const { game: overlaid, errors, warnings } = applyRoster(game, roster);
  if (errors.length > 0) {
    return { game, applied: false, errors, warnings };
  }
  const revalidated = validateGame(JSON.parse(JSON.stringify(overlaid)));
  if (!revalidated.ok) {
    return {
      game,
      applied: false,
      errors: [`roster overlay produced an invalid game: ${revalidated.errors.join("; ")}`],
      warnings,
    };
  }
  return { game: revalidated.game!, applied: true, errors: [], warnings };
}

export interface RosterLoadResult extends RosterApplyResult {
  /** The roster that was read, even if it ultimately failed to apply —
   *  callers need it to build the matching sprite overlay. Null when
   *  nothing was saved, or what was saved couldn't be read at all. */
  roster: Roster | null;
}

/**
 * Read gameId's saved roster (if any) and layer it onto `game`. Never
 * throws and never returns a broken game: an empty/corrupt/foreign roster,
 * or one that fails to apply, comes back as `applied: false` with `game`
 * unchanged and the reason in `errors`.
 */
export function loadRosterOverlay(game: Game, gameId: string): RosterLoadResult {
  const read = readRoster(gameId);
  if (!read.ok) {
    return {
      game,
      applied: false,
      roster: null,
      errors: read.empty ? [] : [read.error],
      warnings: [],
    };
  }
  return { ...applyStoredRoster(game, read.roster), roster: read.roster };
}

// ---- sprite overlay ---------------------------------------------------------

export interface RosterSpriteOverlay {
  /** speciesId -> sprite id, to merge into a sprites.json `species` map. */
  species: Record<string, string>;
  /** One entry per roster species whose art could not be used (no
   *  `spriteDataUrl`, or the image failed to decode) — it renders with its
   *  emoji glyph instead, same as any other unmapped species. */
  warnings: string[];
}

export type ImageLoader = (dataUrl: string) => Promise<HTMLImageElement>;

function defaultLoadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the image could not be decoded"));
    img.src = dataUrl;
  });
}

/** Sprite id namespaced by game and entry so two games' rosters (or two
 *  entries) never collide inside a shared manifest. */
function rosterSpriteId(gameId: string, entryId: string): string {
  return `roster:${gameId}:${entryId}`;
}

/**
 * Decode each roster entry's `spriteDataUrl` and register it directly on
 * `loaded` (mutated in place — the same object every renderer reads from,
 * exactly like the dev forge's sprite hot-swap) as a one-frame "idle"
 * sprite, whole image as the frame. Returns the `speciesId -> spriteId`
 * mapping to merge into a sprites.json document; an entry with no data URL,
 * or whose image fails to load, is simply left out (falls back to glyph)
 * and reported in `warnings` rather than thrown.
 */
export async function applyRosterSprites(
  loaded: LoadedManifest,
  gameId: string,
  roster: Roster,
  loadImage: ImageLoader = defaultLoadImage,
): Promise<RosterSpriteOverlay> {
  const species: Record<string, string> = {};
  const warnings: string[] = [];

  for (const entry of roster.entries) {
    if (!entry.spriteDataUrl) continue;
    const spriteId = rosterSpriteId(gameId, entry.id);
    const sheetId = `${spriteId}:sheet`;
    try {
      const image = await loadImage(entry.spriteDataUrl);
      const tileW = image.naturalWidth || image.width;
      const tileH = image.naturalHeight || image.height;
      if (!tileW || !tileH) throw new Error("the image has no size");
      const sheet: LoadedSheet = {
        def: { src: entry.spriteDataUrl, tileW, tileH },
        image,
        cols: 1,
        rows: 1,
      };
      loaded.sheets.set(sheetId, sheet);
      loaded.manifest.sheets[sheetId] = sheet.def;
      loaded.manifest.sprites[spriteId] = {
        sheet: sheetId,
        anims: { idle: { frames: [[0, 0]], fps: 1 } },
      };
      species[entry.id] = spriteId;
    } catch (e) {
      warnings.push(
        `roster entry "${entry.id}": its sprite ${e instanceof Error ? e.message : String(e)} — showing its glyph instead`,
      );
    }
  }

  return { species, warnings };
}

/**
 * Merge a roster's derived `speciesId -> spriteId` entries into a raw
 * sprites.json document so a single `loadSpriteMap` call resolves both.
 * `base` may be anything, including invalid junk (a broken sprites.json is
 * never fatal elsewhere either) — a non-object base is treated as empty,
 * and the merge itself never throws; schema validation still happens in
 * `loadSpriteMap`, same as before this layer existed.
 */
export function mergeRosterSprites(base: unknown, rosterSpecies: Record<string, string>): unknown {
  const doc = base && typeof base === "object" && !Array.isArray(base) ? (base as Record<string, unknown>) : {};
  const existingSpecies =
    doc.species && typeof doc.species === "object" && !Array.isArray(doc.species)
      ? (doc.species as Record<string, unknown>)
      : {};
  return { ...doc, species: { ...existingSpecies, ...rosterSpecies } };
}
