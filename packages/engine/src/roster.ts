/**
 * Roster overlays: a child-made creature layered onto a shipped game.
 *
 * A roster is a small, sharable JSON document — one or more hand-designed
 * species plus where in the world each one should be found — that gets
 * merged into an existing game WITHOUT touching that game's file:
 *
 *   { "version": 1, "entries": [ { id, name, glyph, types, baseStats,
 *       moves, spriteDataUrl?, location: { mapId, minLevel, maxLevel, weight? } } ] }
 *
 * This is the same discipline as `applyLanguage` in language.ts (the
 * reference implementation): `applyRoster` deep-clones the target game,
 * never mutates its input, and returns a NEW game plus reports rather than
 * throwing. Where a language overlay only ever *replaces* words (and so
 * can't really go wrong), a roster ADDS new balanced content, so most of
 * this file is validation: every entry is checked against the SPECIFIC
 * target game (its catalog, its type chart, its maps) before anything is
 * appended, and a failing entry is skipped with an actionable error rather
 * than corrupting the output.
 *
 * Balance is enforced, not trusted to the author:
 *  - `hp + atk + def + spd` must equal exactly 240 (a fixed stat budget puts
 *    every custom creature at the same power level as the shipped ones —
 *    compare `games/emberwood`'s mid-tier species, which mostly sit in the
 *    200-260 range).
 *  - `catchRate` and `xpYield` are DERIVED from the stat *shape*, not
 *    author-supplied — see `deriveCombatStats` below for the formula.
 *  - `learnset` is DERIVED from the chosen moves on a level curve shaped
 *    like the shipped species (first two moves at level 1, the rest spread
 *    out towards level ~18-22) — see `buildLearnset` below.
 *  - every move id and type must exist in the TARGET game's catalog: a
 *    roster is only ever valid against one specific game.
 *  - `id` must not collide with a shipped species id (or another entry in
 *    the same roster).
 *
 * A roster entry that passes every check is appended to
 * `catalog.species` and given an encounter table entry on its `location`
 * map (reusing that map's existing encounter zone if it has one, else
 * creating one at a modest default rate).
 */
import type { Game, MapDef } from "./schema.js";
import type { Species } from "./catalog.js";
import { z } from "zod";

/** Fixed stat budget every roster entry's base stats must sum to exactly. */
export const ROSTER_STAT_BUDGET = 240;

/** Default per-step encounter rate for a zone created by a roster entry
 *  (only used when the target map has no `encounters` zone yet). */
const DEFAULT_ENCOUNTER_RATE = 0.15;

export const RosterEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  glyph: z.string().min(1).describe("Single visible character or emoji"),
  types: z.array(z.string().min(1)).min(1).max(2),
  baseStats: z.object({
    hp: z.number().int().positive(),
    atk: z.number().int().positive(),
    def: z.number().int().positive(),
    spd: z.number().int().positive(),
  }),
  /** Move ids this creature knows, in the order they should be learned.
   *  Each becomes one learnset entry (see `buildLearnset`); the shipped
   *  species use ~5-7, so more than 7 is rejected here too. */
  moves: z.array(z.string().min(1)).min(1).max(7),
  /** Optional child-drawn sprite, embedded as a data: URL. Carried onto the
   *  generated species object for renderers to read directly — it is NOT
   *  part of `SpeciesSchema`, so re-parsing the game through `validateGame`
   *  silently strips it (out of scope here; see llm-rpg-v4i.5). */
  spriteDataUrl: z.string().min(1).optional(),
  /** Where this creature is found in the target game. */
  location: z.object({
    mapId: z.string().min(1),
    minLevel: z.number().int().min(1),
    maxLevel: z.number().int().min(1),
    /** Relative encounter frequency vs the map's other species. Defaults to 1. */
    weight: z.number().positive().optional(),
  }),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const RosterSchema = z.object({
  /** Format version for this roster document; bump if the shape changes. */
  version: z.number().int().min(1).default(1),
  entries: z.array(RosterEntrySchema).min(1),
});
export type Roster = z.infer<typeof RosterSchema>;

export interface RosterResult {
  game: Game;
  /** One entry was skipped for each of these — the game is unaffected. */
  errors: string[];
  /** Non-fatal notes (e.g. an encounter zone was created on a map with no
   *  wild tiles yet) — the entry was still applied. */
  warnings: string[];
}

/**
 * Derive `catchRate` and `xpYield` from how a creature's fixed 240-point
 * budget is SPENT, since the total itself can't vary (every roster entry
 * is the same power level by construction).
 *
 *   offenseShare = (atk + spd) / total
 *
 * A creature that puts more of its budget into atk/spd (a "glass cannon")
 * is harder to catch and worth more XP; one that puts more into hp/def (a
 * "tank") is easier to catch and worth less. This mirrors the shipped
 * species, where `games/emberwood`'s highest-total (hence rarest, most
 * offensive) creatures also have the lowest catchRate and highest xpYield.
 *
 *   catchRate = clamp(0.55 - offenseShare * 0.6, 0.05, 0.95)   // same clamp
 *   xpYield   = round(80 + offenseShare * 160)                // battle.ts uses
 *
 * At offenseShare ~= 0.5 (a balanced creature) this lands catchRate ~= 0.25
 * and xpYield ~= 160, in line with `games/emberwood`'s mid-tier species at
 * a similar stat total (e.g. hollowpuff: total 240, catchRate 0.18, xpYield 135).
 */
export function deriveCombatStats(baseStats: Species["baseStats"]): {
  catchRate: number;
  xpYield: number;
} {
  const total = baseStats.hp + baseStats.atk + baseStats.def + baseStats.spd;
  const offenseShare = total > 0 ? (baseStats.atk + baseStats.spd) / total : 0;
  const catchRate = Math.min(0.95, Math.max(0.05, 0.55 - offenseShare * 0.6));
  const xpYield = Math.round(80 + offenseShare * 160);
  return { catchRate: Math.round(catchRate * 100) / 100, xpYield };
}

/**
 * Build a learnset from an ordered move list on a curve shaped like the
 * shipped species: the first two moves at level 1 (so a freshly-caught
 * creature already knows two moves), the rest spread evenly between level 5
 * and an end level that grows with the move count (18 for <=5 moves, 20 for
 * 6, 22 for 7 — matching the shipped species' Lv1-22 span).
 */
export function buildLearnset(moves: readonly string[]): { level: number; moveId: string }[] {
  const n = moves.length;
  if (n === 0) return [];
  if (n === 1) return [{ level: 1, moveId: moves[0] }];

  const endLevel = n <= 5 ? 18 : n === 6 ? 20 : 22;
  const startLevel = 5;
  const remaining = n - 2; // moves after the two level-1 starters
  const levels = [1, 1];
  for (let i = 0; i < remaining; i++) {
    const t = remaining === 1 ? 0.5 : i / (remaining - 1);
    let lvl = Math.round(startLevel + t * (endLevel - startLevel));
    if (lvl <= levels[levels.length - 1]) lvl = levels[levels.length - 1] + 1;
    levels.push(lvl);
  }
  return moves.map((moveId, i) => ({ level: levels[i], moveId }));
}

function mapHasWildTiles(game: Game, mapId: string): boolean {
  const map = game.maps[mapId];
  if (!map) return false;
  for (const row of map.rows) {
    for (const ch of row) {
      if (game.legend[ch]?.wild) return true;
    }
  }
  return false;
}

/**
 * Apply a roster to a game: append each valid entry's species to the
 * catalog and its encounter to the named map's table. Pure — deep-clones
 * `game` and never mutates it or `roster`. An entry that fails any balance
 * or cross-reference check is skipped (not applied) and reported in
 * `errors` with a message naming the fix; nothing ever throws.
 */
export function applyRoster(game: Game, roster: Roster): RosterResult {
  const clone = structuredClone(game) as Game;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!clone.catalog) {
    errors.push(
      "roster: target game has no catalog — add a catalog to the game before applying a roster " +
        "(a roster's stats, moves and types are checked against it)",
    );
    return { game: clone, errors, warnings };
  }
  const catalog = clone.catalog;

  const shippedSpeciesIds = new Set(catalog.species.map((s) => s.id));
  const moveIds = new Set(catalog.moves.map((m) => m.id));
  const typeIds = new Set(catalog.typeChart.types);
  const seenRosterIds = new Set<string>();

  for (const [i, entry] of roster.entries.entries()) {
    const tag = `entries[${i}] (${entry.id})`;
    const entryErrors: string[] = [];

    if (shippedSpeciesIds.has(entry.id)) {
      entryErrors.push(
        `${tag}: id "${entry.id}" collides with a shipped species — choose a different id`,
      );
    }
    if (seenRosterIds.has(entry.id)) {
      entryErrors.push(
        `${tag}: id "${entry.id}" is used by another entry in this roster — ids must be unique`,
      );
    }
    seenRosterIds.add(entry.id);

    const { hp, atk, def, spd } = entry.baseStats;
    const total = hp + atk + def + spd;
    if (total !== ROSTER_STAT_BUDGET) {
      entryErrors.push(
        `${tag}: hp+atk+def+spd = ${total}, must equal exactly ${ROSTER_STAT_BUDGET} — ` +
          `adjust the stats by ${ROSTER_STAT_BUDGET - total}`,
      );
    }

    if (entry.types.length === 2 && entry.types[0] === entry.types[1]) {
      entryErrors.push(
        `${tag}.types: lists "${entry.types[0]}" twice — a dual type needs two different types`,
      );
    }
    for (const t of entry.types) {
      if (!typeIds.has(t)) {
        entryErrors.push(
          `${tag}.types: type "${t}" is not in the target game's typeChart — ` +
            `add it to the game or pick one of: ${[...typeIds].join(", ")}`,
        );
      }
    }

    const seenMoves = new Set<string>();
    for (const m of entry.moves) {
      if (!moveIds.has(m)) {
        entryErrors.push(
          `${tag}.moves: moveId "${m}" is not in the target game's catalog — ` +
            `add the move to the game or fix the id`,
        );
      }
      if (seenMoves.has(m)) {
        entryErrors.push(`${tag}.moves: moveId "${m}" is listed more than once — list each move once`);
      }
      seenMoves.add(m);
    }

    const { mapId, minLevel, maxLevel } = entry.location;
    const targetMap: MapDef | undefined = clone.maps[mapId];
    if (!targetMap) {
      entryErrors.push(
        `${tag}.location.mapId: map "${mapId}" does not exist in the target game — ` +
          `use one of: ${Object.keys(clone.maps).join(", ")}`,
      );
    } else if (minLevel > maxLevel) {
      entryErrors.push(
        `${tag}.location: minLevel ${minLevel} is greater than maxLevel ${maxLevel} — swap or adjust them`,
      );
    }

    if (entryErrors.length > 0) {
      errors.push(...entryErrors);
      continue;
    }

    const { catchRate, xpYield } = deriveCombatStats(entry.baseStats);
    const species: Species = {
      id: entry.id,
      name: entry.name,
      glyph: entry.glyph,
      types: entry.types,
      baseStats: entry.baseStats,
      learnset: buildLearnset(entry.moves),
      catchRate,
      xpYield,
    };
    if (entry.spriteDataUrl) {
      (species as Species & { spriteDataUrl?: string }).spriteDataUrl = entry.spriteDataUrl;
    }
    catalog.species.push(species);
    // This entry is now a valid target for later entries in the same roster.
    shippedSpeciesIds.add(entry.id);

    if (!targetMap!.encounters) {
      if (!mapHasWildTiles(clone, mapId)) {
        warnings.push(
          `${tag}: map "${mapId}" has no wild tiles yet — the encounter will never trigger ` +
            `until tiles with "wild": true are added there`,
        );
      }
      targetMap!.encounters = { rate: DEFAULT_ENCOUNTER_RATE, table: [] };
    }
    targetMap!.encounters.table.push({
      speciesId: entry.id,
      minLevel,
      maxLevel,
      weight: entry.location.weight ?? 1,
    });
  }

  return { game: clone, errors, warnings };
}
