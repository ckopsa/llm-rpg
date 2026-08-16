import { z } from "zod";

/**
 * The creature catalog: type chart, moves, and species. Same design bar as
 * the game schema — diffable JSON, writable by an LLM in one shot, and
 * validation errors that name the fix.
 *
 * Decisions (documented here so authors and agents share one truth):
 *  - The type chart supports PARTIAL coverage: any (attack, defend) pair not
 *    listed in `effectiveness` defaults to 1.0. Only non-neutral matchups
 *    need to be written down. Every type name that *is* listed must exist
 *    in `types`, and multipliers must be one of 0, 0.5, 1, 2.
 *  - There is one atk/def stat pair (no special atk/def), so a move's
 *    physical/special category is descriptive flavor — both use atk vs def.
 *    "status" moves must have power 0 and should carry an effect.
 *  - Move effects are minimal stat-stage nudges: raise_* targets the user,
 *    lower_* targets the opponent, one stage per use.
 */

export const MoveEffectSchema = z.object({
  kind: z.enum([
    "raise_atk",
    "raise_def",
    "raise_spd",
    "lower_atk",
    "lower_def",
    "lower_spd",
  ]),
});
export type MoveEffect = z.infer<typeof MoveEffectSchema>;

export const TypeChartSchema = z.object({
  types: z.array(z.string().min(1)).min(1),
  /** effectiveness[attackType][defendType] = multiplier. Missing pairs default to 1.0. */
  effectiveness: z.record(z.string(), z.record(z.string(), z.number())),
});
export type TypeChart = z.infer<typeof TypeChartSchema>;

export const MoveSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  category: z.enum(["physical", "special", "status"]).default("physical"),
  /** Damage base power. Must be 0 for status moves, >= 1 otherwise. */
  power: z.number().int().nonnegative(),
  /** Hit chance 0..1. */
  accuracy: z.number().min(0).max(1),
  pp: z.number().int().positive(),
  effect: MoveEffectSchema.optional(),
});
export type Move = z.infer<typeof MoveSchema>;

export const LearnsetEntrySchema = z.object({
  level: z.number().int().min(1),
  moveId: z.string().min(1),
});
export type LearnsetEntry = z.infer<typeof LearnsetEntrySchema>;

export const SpeciesSchema = z.object({
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
  /** Sorted by level, ascending. Must include at least one level-1 move. */
  learnset: z.array(LearnsetEntrySchema).min(1),
  evolvesTo: z
    .object({
      speciesId: z.string().min(1),
      level: z.number().int().min(2),
    })
    .optional(),
  /** Base capture probability 0..1 at full HP. */
  catchRate: z.number().min(0).max(1),
  xpYield: z.number().int().positive(),
});
export type Species = z.infer<typeof SpeciesSchema>;

export const ItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** "heal" restores HP (requires `amount`); "capture" throws a snare
   *  (requires `ballMod`, a catch-rate multiplier). */
  kind: z.enum(["heal", "capture"]),
  /** HP restored by a heal item. */
  amount: z.number().int().positive().optional(),
  /** Catch-rate multiplier for a capture item (1 = baseline snare). */
  ballMod: z.number().positive().optional(),
  /** Shop price; omit for items that are never sold. */
  price: z.number().int().nonnegative().optional(),
});
export type Item = z.infer<typeof ItemSchema>;

export const CatalogSchema = z.object({
  typeChart: TypeChartSchema,
  moves: z.array(MoveSchema).min(1),
  species: z.array(SpeciesSchema).min(1),
  items: z.array(ItemSchema).default([]),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export interface CatalogValidationResult {
  ok: boolean;
  catalog?: Catalog;
  errors: string[];
}

const VALID_MULTIPLIERS = [0, 0.5, 1, 2];

/**
 * Full validation: zod structure first, then cross-references (type names,
 * move references, evolution targets, id uniqueness, learnset ordering).
 * Every error is written so the author knows what to change.
 */
export function validateCatalog(data: unknown): CatalogValidationResult {
  const parsed = CatalogSchema.safeParse(data);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    return { ok: false, errors };
  }
  const catalog = parsed.data;
  const errors: string[] = [];

  const typeSet = new Set<string>();
  for (const t of catalog.typeChart.types) {
    if (typeSet.has(t)) {
      errors.push(`typeChart.types: duplicate type "${t}" — list each type once`);
    }
    typeSet.add(t);
  }

  for (const [atk, row] of Object.entries(catalog.typeChart.effectiveness)) {
    if (!typeSet.has(atk)) {
      errors.push(
        `typeChart.effectiveness: attack type "${atk}" is not in typeChart.types — add it there or remove this row`,
      );
    }
    for (const [def, mult] of Object.entries(row)) {
      if (!typeSet.has(def)) {
        errors.push(
          `typeChart.effectiveness.${atk}: defend type "${def}" is not in typeChart.types — add it there or remove this entry`,
        );
      }
      if (!VALID_MULTIPLIERS.includes(mult)) {
        errors.push(
          `typeChart.effectiveness.${atk}.${def}: multiplier ${mult} must be one of 0, 0.5, 1, 2`,
        );
      }
    }
  }

  const moveIds = new Set<string>();
  for (const m of catalog.moves) {
    if (moveIds.has(m.id)) {
      errors.push(`moves: duplicate id "${m.id}" — move ids must be unique`);
    }
    moveIds.add(m.id);
    if (!typeSet.has(m.type)) {
      errors.push(
        `moves.${m.id}: type "${m.type}" is not in typeChart.types — add it to the chart or fix the move`,
      );
    }
    if (m.category === "status" && m.power !== 0) {
      errors.push(
        `moves.${m.id}: status moves must have power 0 (got ${m.power}) — set power to 0 or change the category`,
      );
    }
    if (m.category !== "status" && m.power === 0) {
      errors.push(
        `moves.${m.id}: ${m.category} moves must have power >= 1 — give it power or make it a status move`,
      );
    }
    if (m.category === "status" && !m.effect) {
      errors.push(
        `moves.${m.id}: status move has no effect — add an effect (e.g. { "kind": "raise_atk" }) or it does nothing`,
      );
    }
  }

  const speciesIds = new Set<string>();
  for (const s of catalog.species) {
    if (speciesIds.has(s.id)) {
      errors.push(`species: duplicate id "${s.id}" — species ids must be unique`);
    }
    speciesIds.add(s.id);
  }

  for (const s of catalog.species) {
    for (const t of s.types) {
      if (!typeSet.has(t)) {
        errors.push(
          `species.${s.id}: type "${t}" is not in typeChart.types — add it to the chart or fix the species`,
        );
      }
    }
    if (s.types.length === 2 && s.types[0] === s.types[1]) {
      errors.push(
        `species.${s.id}: types lists "${s.types[0]}" twice — a dual type needs two different types`,
      );
    }
    let prevLevel = 0;
    for (const [i, entry] of s.learnset.entries()) {
      if (!moveIds.has(entry.moveId)) {
        errors.push(
          `species.${s.id}.learnset[${i}]: moveId "${entry.moveId}" does not exist — add the move to moves or fix the id`,
        );
      }
      if (entry.level < prevLevel) {
        errors.push(
          `species.${s.id}.learnset[${i}]: level ${entry.level} comes after level ${prevLevel} — sort the learnset by level, ascending`,
        );
      }
      prevLevel = entry.level;
    }
    if (!s.learnset.some((e) => e.level === 1)) {
      errors.push(
        `species.${s.id}: learnset has no level-1 move — a freshly created creature would know nothing`,
      );
    }
    if (s.evolvesTo) {
      if (!speciesIds.has(s.evolvesTo.speciesId)) {
        errors.push(
          `species.${s.id}: evolvesTo.speciesId "${s.evolvesTo.speciesId}" does not exist — add that species or fix the id`,
        );
      } else if (s.evolvesTo.speciesId === s.id) {
        errors.push(
          `species.${s.id}: evolvesTo.speciesId points at itself — evolution must target a different species`,
        );
      }
    }
  }

  const itemIds = new Set<string>();
  for (const item of catalog.items) {
    if (itemIds.has(item.id)) {
      errors.push(`items: duplicate id "${item.id}" — item ids must be unique`);
    }
    itemIds.add(item.id);
    if (item.kind === "heal" && item.amount === undefined) {
      errors.push(
        `items.${item.id}: heal items need an "amount" (HP restored) — add e.g. "amount": 20`,
      );
    }
    if (item.kind === "capture" && item.ballMod === undefined) {
      errors.push(
        `items.${item.id}: capture items need a "ballMod" (catch-rate multiplier) — add e.g. "ballMod": 1`,
      );
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, catalog, errors: [] };
}

/** Look up a species by id. Throws with the id named — call on validated catalogs. */
export function speciesById(catalog: Catalog, id: string): Species {
  const s = catalog.species.find((sp) => sp.id === id);
  if (!s) throw new Error(`speciesById: no species with id "${id}" in catalog`);
  return s;
}

/** Look up a move by id. Throws with the id named — call on validated catalogs. */
export function moveById(catalog: Catalog, id: string): Move {
  const m = catalog.moves.find((mv) => mv.id === id);
  if (!m) throw new Error(`moveById: no move with id "${id}" in catalog`);
  return m;
}

/** Look up an item by id. Throws with the id named — call on validated catalogs. */
export function itemById(catalog: Catalog, id: string): Item {
  const item = catalog.items.find((i) => i.id === id);
  if (!item) throw new Error(`itemById: no item with id "${id}" in catalog`);
  return item;
}

export interface Stats {
  hp: number;
  atk: number;
  def: number;
  spd: number;
}

/**
 * Derived stats at a level (Pokémon-like, no IVs/EVs):
 *   hp     = floor(2 * base.hp * level / 100) + level + 10
 *   others = floor(2 * base    * level / 100) + 5
 */
export function statsAtLevel(species: Species, level: number): Stats {
  const b = species.baseStats;
  const other = (base: number) => Math.floor((2 * base * level) / 100) + 5;
  return {
    hp: Math.floor((2 * b.hp * level) / 100) + level + 10,
    atk: other(b.atk),
    def: other(b.def),
    spd: other(b.spd),
  };
}

/** Move ids known at a level: the last 4 learnset entries with level <= `level`. */
export function movesKnownAtLevel(species: Species, level: number): string[] {
  const learned = species.learnset
    .filter((e) => e.level <= level)
    .map((e) => e.moveId);
  return learned.slice(-4);
}

/**
 * Effectiveness of an attack type against a defender's type(s): the product
 * of per-type multipliers. Pairs missing from the chart default to 1.0.
 */
export function typeMultiplier(
  chart: TypeChart,
  attackType: string,
  defendTypes: readonly string[],
): number {
  let mult = 1;
  for (const def of defendTypes) {
    mult *= chart.effectiveness[attackType]?.[def] ?? 1;
  }
  return mult;
}
