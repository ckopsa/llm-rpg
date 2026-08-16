import type { Game } from "./schema.js";
import { Sim, type SimSnapshot } from "./sim.js";

/**
 * Save-file codec. Pure (no I/O) so it lives in the engine and is testable;
 * packages/play owns the disk format's location (`<gameDir>/saves/<slot>.json`).
 *
 * Version guard: a save records the game's id and version. Loading against a
 * different gameId is an error (the snapshot's positions, flags, and species
 * mean nothing in another game); a different version only warns — small
 * content edits usually load fine, big ones may drift.
 */
export interface SaveFile {
  gameId: string;
  gameVersion: string;
  snapshot: SimSnapshot;
}

/** Package the sim's current state as a save file (JSON-serializable). */
export function makeSaveFile(sim: Sim): SaveFile {
  return {
    gameId: sim.game.meta.id,
    gameVersion: sim.game.meta.version,
    snapshot: sim.snapshot(),
  };
}

export interface LoadedSave {
  sim: Sim;
  /** Non-fatal issues (e.g. a game-version mismatch). Show them to the player. */
  warnings: string[];
}

/**
 * Restore a Sim from parsed save-file JSON. Throws with an actionable message
 * if the data is not a save file or belongs to a different game.
 */
export function loadSaveFile(game: Game, data: unknown): LoadedSave {
  const file = data as Partial<SaveFile> | null;
  if (
    !file ||
    typeof file !== "object" ||
    typeof file.gameId !== "string" ||
    typeof file.gameVersion !== "string" ||
    !file.snapshot ||
    typeof file.snapshot !== "object"
  ) {
    throw new Error(
      'Not a save file — expected an object with "gameId", "gameVersion", and "snapshot".',
    );
  }
  if (file.gameId !== game.meta.id) {
    throw new Error(
      `This save belongs to game "${file.gameId}" but the loaded game is "${game.meta.id}" — load that game's file (meta.id must match) or pick a different save slot.`,
    );
  }
  const warnings: string[] = [];
  if (file.gameVersion !== game.meta.version) {
    warnings.push(
      `Save was made on game version ${file.gameVersion} but the game is now ${game.meta.version} — loading anyway; maps, catalog, or flags may have drifted.`,
    );
  }
  return { sim: Sim.fromSnapshot(game, file.snapshot as SimSnapshot), warnings };
}
