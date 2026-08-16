import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSaveFile, makeSaveFile, type Game, type Sim } from "@llm-rpg/engine";

/**
 * Disk layout for saves: `<gameDir>/saves/<slot>.json` next to the game file
 * (saves/ is gitignored). The file format and version guard live in the
 * engine (`makeSaveFile` / `loadSaveFile`); this module only handles paths
 * and I/O.
 */

export const DEFAULT_SLOT = "quick";

export function savePathFor(gamePath: string, slot: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(slot)) {
    throw new Error(
      `Save slot "${slot}" is invalid — use only letters, digits, "-", "_" (e.g. "quick", "before-fern").`,
    );
  }
  return join(dirname(gamePath), "saves", `${slot}.json`);
}

/** Write the sim to a slot. Returns the file path. */
export function writeSave(gamePath: string, slot: string, sim: Sim): string {
  const path = savePathFor(gamePath, slot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(makeSaveFile(sim), null, 2) + "\n");
  return path;
}

export interface ReadSaveResult {
  sim: Sim;
  warnings: string[];
  path: string;
}

/** Read a slot and restore a Sim. Throws actionably on a missing file,
 *  malformed JSON, or a save from a different game. */
export function readSave(gamePath: string, slot: string, game: Game): ReadSaveResult {
  const path = savePathFor(gamePath, slot);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read save "${slot}" (${path}): ${(err as Error).message}`);
  }
  const { sim, warnings } = loadSaveFile(game, raw);
  return { sim, warnings, path };
}
