/**
 * Browser save slots: localStorage wrapper around the engine's save codec.
 *
 * Keys are namespaced by gameId (`llmrpg:save:<gameId>:<slot>`), so each
 * game only ever sees its own saves; the engine's gameId guard still runs on
 * load as a belt-and-braces check. Slots: "1" | "2" | "3" plus "auto"
 * (written silently after battles and map transitions).
 *
 * Corrupt or foreign data never throws out of this module — every read
 * returns a tagged result the UI can describe gently.
 */
import { loadSaveFile, makeSaveFile, Sim, type Game } from "@llm-rpg/engine";

export type SlotId = "1" | "2" | "3" | "auto";
export const MANUAL_SLOTS: readonly SlotId[] = ["1", "2", "3"];
export const ALL_SLOTS: readonly SlotId[] = ["1", "2", "3", "auto"];

const key = (gameId: string, slot: SlotId) => `llmrpg:save:${gameId}:${slot}`;

/** Stored value: engine SaveFile plus a timestamp for the slot UI. */
interface StoredSave {
  savedAt: string;
  file: unknown;
}

export interface SlotPeek {
  slot: SlotId;
  exists: boolean;
  corrupt: boolean;
  savedAt?: string;
  /** Map id recorded in the snapshot, when peekable. */
  mapId?: string;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage disabled (privacy mode etc.) — saves just vanish
  }
}

/** Cheap slot inspection for menu labels; never throws. */
export function peekSlot(gameId: string, slot: SlotId): SlotPeek {
  const store = storage();
  const raw = store?.getItem(key(gameId, slot));
  if (!raw) return { slot, exists: false, corrupt: false };
  try {
    const stored = JSON.parse(raw) as Partial<StoredSave>;
    const file = stored.file as { snapshot?: { map?: unknown } } | undefined;
    if (!file || typeof file !== "object") throw new Error("no save payload");
    return {
      slot,
      exists: true,
      corrupt: false,
      savedAt: typeof stored.savedAt === "string" ? stored.savedAt : undefined,
      mapId: typeof file.snapshot?.map === "string" ? file.snapshot.map : undefined,
    };
  } catch {
    return { slot, exists: true, corrupt: true };
  }
}

export type WriteResult = { ok: true } | { ok: false; error: string };

/** Write the sim's current state to a slot. */
export function writeSlot(gameId: string, slot: SlotId, sim: Sim): WriteResult {
  const store = storage();
  if (!store) return { ok: false, error: "This browser is not letting the game keep saves." };
  try {
    const stored: StoredSave = {
      savedAt: new Date().toISOString(),
      file: makeSaveFile(sim),
    };
    store.setItem(key(gameId, slot), JSON.stringify(stored));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not save: ${String(e)}` };
  }
}

export type ReadResult =
  | { ok: true; sim: Sim; warnings: string[]; savedAt?: string }
  | { ok: false; error: string }
  | { ok: false; empty: true; error: string };

/** Restore a Sim from a slot. Corruption and mismatches come back as errors. */
export function readSlot(game: Game, slot: SlotId): ReadResult {
  const store = storage();
  const raw = store?.getItem(key(game.meta.id, slot));
  if (!raw) return { ok: false, empty: true, error: "That slot is empty." };
  try {
    const stored = JSON.parse(raw) as Partial<StoredSave>;
    const { sim, warnings } = loadSaveFile(game, stored.file);
    return {
      ok: true,
      sim,
      warnings,
      savedAt: typeof stored.savedAt === "string" ? stored.savedAt : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      error: `That save couldn't be read (${e instanceof Error ? e.message : String(e)}).`,
    };
  }
}

/** The most recently written readable slot, or null when none exist. */
export function newestSlot(gameId: string): SlotId | null {
  let best: SlotId | null = null;
  let bestAt = "";
  for (const slot of ALL_SLOTS) {
    const peek = peekSlot(gameId, slot);
    if (!peek.exists || peek.corrupt) continue;
    const at = peek.savedAt ?? "0";
    if (best === null || at > bestAt) {
      best = slot;
      bestAt = at;
    }
  }
  return best;
}

export function hasAnySave(gameId: string): boolean {
  return newestSlot(gameId) !== null;
}

/** "2026-08-16T..." -> "Aug 16, 14:05" (best-effort, for slot labels). */
export function prettyTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
