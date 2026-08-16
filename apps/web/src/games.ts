/**
 * Game discovery: every games/<dir>/game.json in the repo is a playable game.
 *
 * Files are globbed as RAW TEXT (not parsed JSON modules) on purpose: a game
 * being authored in parallel may be absent, half-written, or invalid JSON at
 * any moment, and none of that may break the build or crash the app. All
 * parsing happens lazily at runtime with friendly errors.
 */

const gameFiles = import.meta.glob("../../../games/*/game.json", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const spriteFiles = import.meta.glob("../../../games/*/sprites.json", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

function dirOf(path: string): string | null {
  const m = /games\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

function byDir(files: Record<string, () => Promise<string>>): Map<string, () => Promise<string>> {
  const map = new Map<string, () => Promise<string>>();
  for (const [path, loader] of Object.entries(files)) {
    const dir = dirOf(path);
    if (dir) map.set(dir, loader);
  }
  return map;
}

const games = byDir(gameFiles);
const sprites = byDir(spriteFiles);

/** Directory names of every discovered game, sorted. */
export function listGameIds(): string[] {
  return [...games.keys()].sort();
}

/** "emberwood" when present, else "demo", else the first discovered game. */
export function defaultGameId(): string {
  const ids = listGameIds();
  if (ids.includes("emberwood")) return "emberwood";
  if (ids.includes("demo")) return "demo";
  return ids[0] ?? "demo";
}

/** Game selected by the ?game=<dirname> URL param, defaulting sensibly. */
export function selectedGameId(): string {
  const param = new URLSearchParams(window.location.search).get("game");
  return param && param.trim() !== "" ? param.trim() : defaultGameId();
}

/** A known-good game to link back to when the selected one fails. */
export function fallbackGameId(brokenId: string): string | null {
  const ids = listGameIds().filter((id) => id !== brokenId);
  if (ids.includes("demo")) return "demo";
  return ids[0] ?? null;
}

export type RawResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** Load and JSON-parse a game's game.json. Never throws. */
export async function loadGameRaw(id: string): Promise<RawResult> {
  const loader = games.get(id);
  if (!loader) {
    const known = listGameIds().join(", ") || "(none found)";
    return { ok: false, error: `No game named "${id}" was found. Known games: ${known}.` };
  }
  let text: string;
  try {
    text = await loader();
  } catch (e) {
    return { ok: false, error: `Could not load games/${id}/game.json: ${String(e)}` };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `games/${id}/game.json is not valid JSON: ${String(e)}` };
  }
}

/**
 * Load a game's sprites.json, or null when absent/unreadable/invalid —
 * the caller falls back to all-glyph rendering (warned, never fatal).
 */
export async function loadSpritesRaw(id: string): Promise<unknown | null> {
  const loader = sprites.get(id);
  if (!loader) return null;
  try {
    return JSON.parse(await loader());
  } catch (e) {
    console.warn(`games/${id}/sprites.json unreadable — using emoji glyphs:`, e);
    return null;
  }
}

export interface GameListing {
  id: string;
  /** meta.title when the file parses, else the directory name. */
  title: string;
  /** True when game.json parsed and looked like a game. */
  loads: boolean;
}

/** Best-effort id + title for every discovered game (for the chooser). */
export async function listGames(): Promise<GameListing[]> {
  return Promise.all(
    listGameIds().map(async (id) => {
      const raw = await loadGameRaw(id);
      if (raw.ok) {
        const meta = (raw.data as { meta?: { title?: unknown } } | null)?.meta;
        const title = typeof meta?.title === "string" ? meta.title : id;
        return { id, title, loads: true };
      }
      return { id, title: id, loads: false };
    }),
  );
}
