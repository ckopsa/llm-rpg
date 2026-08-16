import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  applyOps,
  createGame,
  validateGame,
  type ApplyOpsResult,
  type ForgeOpCall,
  type ValidationResult,
} from "@llm-rpg/engine";
import { REPO_ROOT } from "./load.js";

/**
 * Persistence layer for the MCP Forge server: games live on disk as
 * games/<dir>/game.json, edits go read file -> applyOps -> ATOMIC write
 * (tmp + rename), and only ACCEPTED ops write anything — a rejected op
 * leaves the file byte-identical. Advisory validation failures do NOT block
 * writes: drafts are storable by design.
 *
 * Undo: before every write the previous raw file content is appended to
 * games/<dir>/.forge-history/<n>.json (monotonic n, capped at the newest
 * HISTORY_CAP entries, gitignored). `undoLast` restores the newest entry
 * byte-for-byte and pops it.
 */

export const GAME_FILE = "game.json";
export const HISTORY_DIR = ".forge-history";
export const HISTORY_CAP = 50;
export const DEFAULT_GAMES_DIR = join(REPO_ROOT, "games");

export function gameDirOf(gamesDir: string, dirName: string): string {
  return join(gamesDir, dirName);
}

export function gameFileOf(gamesDir: string, dirName: string): string {
  return join(gamesDir, dirName, GAME_FILE);
}

// ---------------------------------------------------------------------------
// Reading and listing
// ---------------------------------------------------------------------------

/** Read and parse a game file. Throws with an actionable message. */
export function readDoc(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${(err as Error).message}) — fix the file by hand or restore it with forge_undo`,
    );
  }
}

export interface GameListing {
  dirName: string;
  id: string | null;
  title: string | null;
  valid: boolean;
  /** validateGame error count (0 when valid); -1 when the file can't be parsed. */
  errorCount: number;
}

/** Every games/<dir>/game.json directly under gamesDir. Directories whose
 *  name starts with "_" (e.g. _templates) are NOT games and are skipped. */
export function listGames(gamesDir: string): GameListing[] {
  if (!existsSync(gamesDir)) return [];
  const out: GameListing[] = [];
  for (const entry of readdirSync(gamesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const file = gameFileOf(gamesDir, entry.name);
    if (!existsSync(file)) continue;
    let doc: unknown;
    try {
      doc = readDoc(file);
    } catch {
      out.push({ dirName: entry.name, id: null, title: null, valid: false, errorCount: -1 });
      continue;
    }
    const v = validateGame(doc);
    const meta =
      typeof doc === "object" && doc !== null && !Array.isArray(doc)
        ? ((doc as Record<string, unknown>).meta as Record<string, unknown> | undefined)
        : undefined;
    out.push({
      dirName: entry.name,
      id: typeof meta?.id === "string" ? meta.id : null,
      title: typeof meta?.title === "string" ? meta.title : null,
      valid: v.ok,
      errorCount: v.errors.length,
    });
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

// ---------------------------------------------------------------------------
// Atomic writes and history
// ---------------------------------------------------------------------------

/** Serialize exactly the way every game file in the repo is stored. */
export function serializeDoc(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Write via tmp file + rename so a crash never leaves a torn game.json. */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function historyEntries(gameDir: string): number[] {
  const dir = join(gameDir, HISTORY_DIR);
  if (!existsSync(dir)) return [];
  const ns: number[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(name);
    if (m) ns.push(Number(m[1]));
  }
  return ns.sort((a, b) => a - b);
}

/** Number of undo steps currently stored. */
export function historyCount(gameDir: string): number {
  return historyEntries(gameDir).length;
}

/** Append `prevContent` as the newest history entry, pruning the oldest
 *  entries beyond HISTORY_CAP. */
export function appendHistory(gameDir: string, prevContent: string): void {
  const dir = join(gameDir, HISTORY_DIR);
  mkdirSync(dir, { recursive: true });
  const entries = historyEntries(gameDir);
  const next = entries.length > 0 ? entries[entries.length - 1] + 1 : 1;
  writeFileAtomic(join(dir, `${next}.json`), prevContent);
  const all = [...entries, next];
  while (all.length > HISTORY_CAP) {
    const oldest = all.shift()!;
    unlinkSync(join(dir, `${oldest}.json`));
  }
}

export interface UndoResult {
  restored: boolean;
  /** Undo steps remaining after this call. */
  remaining: number;
  message: string;
}

/** Restore the newest history entry over game.json and pop it. */
export function undoLast(gameDir: string): UndoResult {
  const entries = historyEntries(gameDir);
  if (entries.length === 0) {
    return {
      restored: false,
      remaining: 0,
      message: "nothing to undo — no history entries exist for this game yet",
    };
  }
  const newest = entries[entries.length - 1];
  const entryPath = join(gameDir, HISTORY_DIR, `${newest}.json`);
  const content = readFileSync(entryPath, "utf8");
  writeFileAtomic(join(gameDir, GAME_FILE), content);
  unlinkSync(entryPath);
  return {
    restored: true,
    remaining: entries.length - 1,
    message: `restored ${GAME_FILE} to its state before the last accepted edit (${entries.length - 1} undo step(s) remain)`,
  };
}

// ---------------------------------------------------------------------------
// Applying ops to a file
// ---------------------------------------------------------------------------

export interface ApplyToFileResult {
  result: ApplyOpsResult;
  /** True when the ops were accepted and the file was rewritten. */
  wrote: boolean;
}

/**
 * The persistence contract: read game.json -> applyOps -> when (and only
 * when) every op is accepted, snapshot the previous content into history and
 * atomically rewrite the file. Advisory validation errors do NOT prevent the
 * write — an invalid draft is a normal, storable authoring state. A rejected
 * op writes nothing (the file stays byte-identical).
 */
export function applyToFile(gameDir: string, ops: ForgeOpCall[]): ApplyToFileResult {
  const path = join(gameDir, GAME_FILE);
  const prevContent = readFileSync(path, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(prevContent);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${(err as Error).message}) — restore it with forge_undo before editing`,
    );
  }
  const result = applyOps(doc, ops);
  if (result.ok) {
    appendHistory(gameDir, prevContent);
    writeFileAtomic(path, serializeDoc(result.doc));
  }
  return { result, wrote: result.ok };
}

// ---------------------------------------------------------------------------
// New game from a template
// ---------------------------------------------------------------------------

export interface NewGameOptions {
  dirName: string;
  id: string;
  title: string;
  goal: string;
  /** A directory under games/_templates (default "starter"), or "blank" for
   *  a bare createGame draft with no maps yet. */
  template?: string;
}

export interface NewGameResult {
  dir: string;
  doc: unknown;
  validation: ValidationResult;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function resolveTemplateDir(gamesDir: string, template: string): string {
  const local = join(gamesDir, "_templates", template);
  if (existsSync(join(local, GAME_FILE))) return local;
  const repo = join(DEFAULT_GAMES_DIR, "_templates", template);
  if (existsSync(join(repo, GAME_FILE))) return repo;
  throw new Error(
    `template "${template}" not found — expected ${join(local, GAME_FILE)}; use template "starter" (the shipped teaching game) or "blank" (empty draft)`,
  );
}

/** Minimal sprites.json for a blank draft — everything falls back to glyphs. */
const BLANK_SPRITES =
  serializeDoc({
    _comment:
      "Maps tile NAMES (from the game legend), species ids, and entity ids to sprite ids in apps/web/public/assets/manifest.json. Anything unmapped falls back to the game's emoji glyph.",
    tiles: {},
    species: {},
    entities: {},
    player: "player",
  });

/**
 * Create games/<dirName>/ with a game.json (template copy with meta.id,
 * title, goal replaced; version reset to 0.1.0) and a sprites.json (copied
 * from the template, or a minimal fallback). Refuses to overwrite anything.
 */
export function newGameFromTemplate(gamesDir: string, opts: NewGameOptions): NewGameResult {
  const template = opts.template ?? "starter";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts.dirName) || opts.dirName.startsWith("_")) {
    throw new Error(
      `dirName "${opts.dirName}" is invalid — use letters, digits, "-", "_", not starting with "_" (a leading underscore hides the directory from game listings)`,
    );
  }
  const dir = gameDirOf(gamesDir, opts.dirName);
  if (existsSync(dir)) {
    throw new Error(
      `${dir} already exists — forge_new_game never overwrites; pick another dirName, or forge_open the existing game to edit it`,
    );
  }

  let doc: Record<string, unknown>;
  let templateSprites: string | undefined;
  if (template === "blank") {
    const created = createGame({ id: opts.id, title: opts.title, goal: opts.goal });
    doc = created.doc as Record<string, unknown>;
  } else {
    const templateDir = resolveTemplateDir(gamesDir, template);
    const raw = readDoc(join(templateDir, GAME_FILE));
    if (!isRecord(raw)) {
      throw new Error(`template "${template}" game.json is not a JSON object — fix the template`);
    }
    doc = structuredClone(raw);
    const spritesPath = join(templateDir, "sprites.json");
    if (existsSync(spritesPath)) templateSprites = spritesPath;
  }
  doc.meta = {
    ...(isRecord(doc.meta) ? doc.meta : {}),
    id: opts.id,
    title: opts.title,
    version: "0.1.0",
    goal: opts.goal,
  };

  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, GAME_FILE), serializeDoc(doc));
  if (templateSprites) copyFileSync(templateSprites, join(dir, "sprites.json"));
  else writeFileAtomic(join(dir, "sprites.json"), BLANK_SPRITES);

  return { dir, doc, validation: validateGame(doc) };
}
