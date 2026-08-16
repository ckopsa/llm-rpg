import { z } from "zod";
import { CatalogSchema, validateCatalog } from "./catalog.js";

/**
 * A game is a single JSON document. Design constraints, in order:
 *  1. Diffable — every meaningful change to a game is a readable text diff.
 *  2. Writable by an LLM in one shot — compact map rows, no coordinates in the grid.
 *  3. Validation errors must name the fix, not just the failure.
 *
 * A game is a multi-map overworld: `maps` is a record of named maps (towns,
 * routes, interiors) connected by portals. The `legend` is shared by all maps.
 */

export const TileSchema = z.object({
  name: z.string().min(1),
  glyph: z.string().min(1).describe("Single visible character or emoji"),
  walkable: z.boolean(),
  /** Wild-encounter tile (e.g. tall grass). Stepping on one rolls against the
   *  map's `encounters` zone. */
  wild: z.boolean().default(false),
});
export type Tile = z.infer<typeof TileSchema>;

/**
 * Unified condition object, usable on interactions and on every command
 * (`when`). Evaluated by `evalWhen` against { flags, vars, money }:
 *  - { flag } / { notFlag }        — boolean flag tests
 *  - { var, op, value }            — compare a variable against a number or
 *    string. A missing var reads as 0 for number comparisons and "" for
 *    string comparisons. "money" is a built-in readable var (player money).
 *  - { all } / { any } / { not }   — composition (arbitrarily nested)
 * `requiresFlag`/`forbidsFlag` on interactions remain as sugar and are ANDed
 * with `when`.
 */
export type WhenOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export type When =
  | { flag: string }
  | { notFlag: string }
  | { var: string; op: WhenOp; value: number | string }
  | { all: When[] }
  | { any: When[] }
  | { not: When };

export const WhenSchema: z.ZodType<When> = z.lazy(() =>
  z.union([
    z.object({ flag: z.string().min(1) }).strict(),
    z.object({ notFlag: z.string().min(1) }).strict(),
    z
      .object({
        var: z.string().min(1),
        op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
        value: z.union([z.number(), z.string()]),
      })
      .strict(),
    z.object({ all: z.array(WhenSchema).min(1) }).strict(),
    z.object({ any: z.array(WhenSchema).min(1) }).strict(),
    z.object({ not: WhenSchema }).strict(),
  ]),
);

/** What `evalWhen` reads. `vars` are game variables; `money` backs the
 *  built-in "money" var. */
export interface WhenContext {
  flags: readonly string[];
  vars: Readonly<Record<string, number | string>>;
  money: number;
}

function compareSame(op: WhenOp, a: number | string, b: number | string): boolean {
  // Callers guarantee typeof a === typeof b; JS <,> compare strings lexically.
  switch (op) {
    case "eq":
      return a === b;
    case "ne":
      return a !== b;
    case "lt":
      return (a as number) < (b as number);
    case "lte":
      return (a as number) <= (b as number);
    case "gt":
      return (a as number) > (b as number);
    case "gte":
      return (a as number) >= (b as number);
  }
}

/** Evaluate a When condition. Type-mismatched var comparisons (a string var
 *  against a number value, or vice versa) are never equal and never ordered:
 *  only "ne" is true. */
export function evalWhen(ctx: WhenContext, when: When): boolean {
  if ("flag" in when) return ctx.flags.includes(when.flag);
  if ("notFlag" in when) return !ctx.flags.includes(when.notFlag);
  if ("all" in when) return when.all.every((w) => evalWhen(ctx, w));
  if ("any" in when) return when.any.some((w) => evalWhen(ctx, w));
  if ("not" in when) return !evalWhen(ctx, when.not);
  const raw = when.var === "money" ? ctx.money : ctx.vars[when.var];
  const actual = raw ?? (typeof when.value === "number" ? 0 : "");
  if (typeof actual !== typeof when.value) return when.op === "ne";
  return compareSame(when.op, actual, when.value);
}

/** Shared shape helper: every command variant carries an optional `when`
 *  gate (the command is silently skipped when it evaluates false). */
function command<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    ...shape,
    when: WhenSchema.optional(),
  });
}

/** Cardinal step direction, shared by movement commands. */
export const DirectionSchema = z.enum(["north", "south", "east", "west"]);

/** One conditional appearance of an entity. The FIRST variant whose `when`
 *  passes wins (a variant with no `when` always matches); base entity fields
 *  are the fallback. `set_variant` forces a specific variant until cleared.
 *  `sprite` is a web-manifest sprite id — the engine passes it through. */
export const EntityVariantSchema = z.object({
  id: z.string().min(1),
  when: WhenSchema.optional(),
  glyph: z.string().min(1).optional(),
  sprite: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
export type EntityVariant = z.infer<typeof EntityVariantSchema>;

/**
 * Full entity shape, declared explicitly (not z.infer) so `spawn_entity` can
 * nest EntitySchema without a circular type (entity → interactions →
 * commands → spawn_entity → entity). Kept in sync with EntitySchema; the
 * inferred `Entity` type is structurally identical.
 */
export interface EntityDef {
  id: string;
  name: string;
  glyph: string;
  x: number;
  y: number;
  blocking: boolean;
  passableWithFlag?: string;
  interactions: Interaction[];
  trainer?: Trainer;
  sprite?: string;
  variants?: EntityVariant[];
}

/** One option of a `choice` command. `when`-gated options are hidden when the
 *  gate fails; the chosen option's commands run, then any commands that were
 *  suspended after the choice resume. Recursive: options may contain further
 *  `choice` commands (nested chains). */
export interface ChoiceOption {
  label: string;
  when?: When;
  commands: Command[];
}

export const ChoiceOptionSchema: z.ZodType<ChoiceOption> = z.lazy(() =>
  z.object({
    label: z.string().min(1),
    when: WhenSchema.optional(),
    commands: z
      .array(CommandSchema)
      .min(1, "commands needs at least one command"),
  }),
);

export const CommandSchema = z.discriminatedUnion("type", [
  command("say", { text: z.string().min(1) }),
  command("set_flag", { flag: z.string().min(1) }),
  command("win", { text: z.string().min(1) }),
  /** Set a variable to a number or string (creates it if missing). */
  command("set_var", {
    var: z.string().min(1),
    value: z.union([z.number(), z.string()]),
  }),
  /** Add to a numeric variable (a missing var starts at 0). Adding to a
   *  string-valued var is a validation error where statically knowable and a
   *  runtime event otherwise. */
  command("add_var", {
    var: z.string().min(1),
    amount: z.number(),
  }),
  /** Long-form text: a multi-line passage (poetry, narration, scripture).
   *  Rendered in full by observers — the text carries the weight. */
  command("passage", {
    title: z.string().min(1).optional(),
    lines: z
      .array(z.string().min(1))
      .min(1, "lines needs at least one line of text"),
    citation: z.string().min(1).optional(),
  }),
  /** Add a creature to the party (fails with an event if the party is full).
   *  Starter choice is spatial: three pedestal entities each give a different
   *  starter and set a shared flag like "starter_chosen" via forbidsFlag gates. */
  command("give_species", {
    speciesId: z.string().min(1),
    level: z.number().int().min(1, "level must be at least 1"),
  }),
  command("give_item", {
    itemId: z.string().min(1),
    qty: z.number().int().min(1, "qty must be at least 1"),
  }),
  command("give_money", {
    amount: z.number().int().min(1, "amount must be at least 1"),
  }),
  /** Heal-hearth: restores every party member's HP and PP. */
  command("heal_party", {}),
  /** Shop counter: the player BUYS 1x itemId for `price` coins (deducted on
   *  success; a failure event names the shortfall). Shops are spatial — one
   *  shopkeeper/counter entity (or one interaction) per item, no menu system. */
  command("sell", {
    itemId: z.string().min(1),
    price: z.number().int().min(0, "price must be zero or more"),
  }),
  /** Dialogue choice (overworld only — a validation error inside trainer
   *  rewardCommands, which run battle-side). Presenting a choice SUSPENDS the
   *  remaining commands of the current list and sets `state.pendingChoice`;
   *  the sim then accepts only `choose1..chooseN`. The chosen option's
   *  commands run first, then the suspended commands resume — so
   *  "say → choice → say-epilogue" reads the way an author expects. Options
   *  whose `when` fails are hidden; if none remain, an event explains it and
   *  the choice is skipped. Nested choices stack. */
  command("choice", {
    prompt: z.string().min(1),
    options: z
      .array(ChoiceOptionSchema)
      .min(1, "options needs at least one option"),
  }),
  /** Cutscene: walk an entity tile-by-tile along `path` (world overlays track
   *  the new position). A blocked step (out of bounds, unwalkable, occupied by
   *  an entity or the player) stops the remaining movement with an event. */
  command("move_entity", {
    entityId: z.string().min(1),
    path: z.array(DirectionSchema).min(1, "path needs at least one step"),
  }),
  /** Cutscene: add a full entity at runtime (default: the player's current
   *  map). A duplicate id is a validation error against placed entities and a
   *  runtime event otherwise; an occupied or out-of-bounds tile is a runtime
   *  event. */
  command("spawn_entity", {
    mapId: z.string().min(1).optional(),
    // Explicitly annotated to break the schema type cycle (entity →
    // interactions → commands → spawn_entity → entity); EntityDef mirrors
    // EntitySchema's output exactly.
    entity: z.lazy(
      (): z.ZodType<EntityDef> => EntitySchema as unknown as z.ZodType<EntityDef>,
    ),
  }),
  /** Cutscene: remove an entity from the world (placed or spawned). */
  command("remove_entity", { entityId: z.string().min(1) }),
  /** Cutscene: repaint one tile to another legend char (default: the current
   *  map). Walkability/wildness follow the new char's legend entry. */
  command("set_tile", {
    mapId: z.string().min(1).optional(),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    char: z.string().min(1),
  }),
  /** Cutscene pacing marker for renderers — no sim effect beyond a cue. */
  command("wait", {
    beats: z.number().int().min(1, "beats must be at least 1"),
  }),
  /** Renderer-directed camera: exactly one of { entityId }, { mapId?, x, y },
   *  or { release: true } (checked by validateGame). The focused entity/tile
   *  may be on another map — that's how observed scenes work. */
  command("camera_focus", {
    entityId: z.string().min(1).optional(),
    mapId: z.string().min(1).optional(),
    x: z.number().int().nonnegative().optional(),
    y: z.number().int().nonnegative().optional(),
    release: z.literal(true).optional(),
  }),
  /** Renderer-directed music cue. `track` is a free-form track id. */
  command("play_music", { track: z.string().min(1) }),
  /** Renderer-directed screen effect cue. */
  command("screen_effect", { effect: z.enum(["shake", "flash", "fade"]) }),
  /** End the game with a named ending. `win` is sugar for
   *  `end { id: "victory" }`; only id "victory" counts as winning. After any
   *  ending the sim refuses further actions. An ungated `end` must be the
   *  last command of its list. */
  command("end", { id: z.string().min(1), text: z.string().min(1) }),
  /** Relocate the player (destination statically validated) and fire the
   *  target map's `enter` triggers. */
  command("teleport_player", {
    mapId: z.string().min(1),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  /** Act/chapter title card — a cue plus a formatted event. */
  command("show_title", {
    text: z.string().min(1),
    subtitle: z.string().min(1).optional(),
  }),
  /** Force an entity's variant (`variantId`) or return it to when-evaluation
   *  (`clear: true`) — exactly one of the two (checked by validateGame). */
  command("set_variant", {
    entityId: z.string().min(1),
    variantId: z.string().min(1).optional(),
    clear: z.literal(true).optional(),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;
/** The `choice` command variant (see CommandSchema). */
export type ChoiceCommand = Extract<Command, { type: "choice" }>;

export const InteractionSchema = z.object({
  requiresFlag: z.string().optional(),
  /** Interaction is SKIPPED if this flag is set — for one-time gifts
   *  (e.g. starter pedestals that all check "starter_chosen"). */
  forbidsFlag: z.string().optional(),
  /** Unified condition, ANDed with requiresFlag/forbidsFlag (which remain
   *  as sugar). The first interaction whose gates all pass runs. */
  when: WhenSchema.optional(),
  commands: z.array(CommandSchema).min(1),
});
export type Interaction = z.infer<typeof InteractionSchema>;

export const PartyMemberSchema = z.object({
  speciesId: z.string().min(1),
  level: z.number().int().min(1, "level must be at least 1"),
});
export type PartyMember = z.infer<typeof PartyMemberSchema>;

/** An NPC who battles the player (mode "trainer": no run, no catch).
 *  While `defeatFlag` is unset, interacting starts the battle — and with
 *  `lineOfSight`, so does stepping into the watched tiles. */
export const TrainerSchema = z.object({
  /** Enemy party, sent out in order. */
  party: z.array(PartyMemberSchema).min(1).max(6),
  /** Set on the player's victory; a defeated trainer acts as a normal NPC. */
  defeatFlag: z.string().min(1),
  /** Auto-engage when the player stands within `range` tiles straight along
   *  `dir` from the trainer with no blocking tile or entity between. */
  lineOfSight: z
    .object({
      dir: z.enum(["north", "south", "east", "west"]),
      range: z.number().int().min(1, "range must be at least 1"),
    })
    .optional(),
  /** Coins awarded on victory. */
  rewardMoney: z.number().int().min(1, "rewardMoney must be at least 1").optional(),
  /** Commands run on victory, after rewardMoney (e.g. give_item, set_flag, win). */
  rewardCommands: z.array(CommandSchema).optional(),
  /** Shouted when the battle starts. */
  intro: z.string().min(1).optional(),
  /** Said right after losing to the player. */
  defeatText: z.string().min(1).optional(),
  /** Default chat line after defeat when the entity has no interactions. */
  outro: z.string().min(1).optional(),
});
export type Trainer = z.infer<typeof TrainerSchema>;

export const EntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  glyph: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  blocking: z.boolean().default(true),
  /** If set, this entity stops blocking once the flag is set (e.g. a guard
   *  who steps aside after you earn the elder's blessing). */
  passableWithFlag: z.string().min(1).optional(),
  /** First interaction whose requiresFlag is satisfied (or absent) runs.
   *  Order gated interactions before ungated fallbacks. */
  interactions: z.array(InteractionSchema).default([]),
  /** Makes this entity a battling trainer NPC (see TrainerSchema). While the
   *  trainer's defeatFlag is unset, `interactions` are unreachable — they
   *  become the entity's post-defeat dialogue. */
  trainer: TrainerSchema.optional(),
  /** Web-manifest sprite id for renderers; the engine passes it through. */
  sprite: z.string().min(1).optional(),
  /** Conditional appearances: first `when`-match wins, base fields as
   *  fallback. `set_variant` forces one until cleared. */
  variants: z.array(EntityVariantSchema).min(1).optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

export const PortalSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  toMap: z.string().min(1),
  toX: z.number().int().nonnegative(),
  toY: z.number().int().nonnegative(),
});
export type Portal = z.infer<typeof PortalSchema>;

export const EncounterEntrySchema = z
  .object({
    /** Free-form species id; resolved against a creature catalog elsewhere. */
    speciesId: z.string().min(1),
    minLevel: z.number().int().min(1, "minLevel must be at least 1"),
    maxLevel: z.number().int().min(1, "maxLevel must be at least 1"),
    weight: z
      .number()
      .positive("weight must be a positive number — it sets relative encounter frequency"),
  });
export type EncounterEntry = z.infer<typeof EncounterEntrySchema>;

export const EncounterZoneSchema = z.object({
  /** Probability (0..1) that a step onto a wild tile triggers an encounter. */
  rate: z
    .number()
    .min(0, "rate must be between 0 and 1 (probability per step on a wild tile)")
    .max(1, "rate must be between 0 and 1 (probability per step on a wild tile)"),
  table: z.array(EncounterEntrySchema).min(1, "table needs at least one species entry"),
});
export type EncounterZone = z.infer<typeof EncounterZoneSchema>;

/**
 * A map trigger: a command list fired by the world, not by `interact`.
 *  - `on: "enter"` fires on ARRIVING on the map: game start (for the start
 *    map), portal arrival, and `teleport_player` arrival. Respawn after a
 *    party wipe does not count.
 *  - `on: "step"` fires when the player lands on one of `tiles` (required
 *    for step triggers) — by walking, or by portal arrival on that tile.
 * `once` (default true) fires at most once per game, tracked in
 * `state.firedTriggers` as "mapId:id"; a trigger whose `when` fails is
 * skipped WITHOUT being marked fired, so it can fire later. Trigger commands
 * run through the same pipeline as interactions (choice/passage work); a
 * trigger firing while commands are already pending queues after them.
 */
export const TriggerSchema = z.object({
  id: z.string().min(1),
  on: z.enum(["enter", "step"]),
  /** Tiles that fire a "step" trigger (required for step, invalid for enter). */
  tiles: z
    .array(
      z.object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
      }),
    )
    .min(1, "tiles needs at least one { x, y } entry")
    .optional(),
  once: z.boolean().default(true),
  when: WhenSchema.optional(),
  commands: z.array(CommandSchema).min(1, "commands needs at least one command"),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const MapDefSchema = z.object({
  rows: z.array(z.string().min(1)).min(1),
  entities: z.array(EntitySchema).default([]),
  portals: z.array(PortalSchema).default([]),
  /** Wild-encounter table for this map's `wild` tiles. */
  encounters: EncounterZoneSchema.optional(),
  /** Map triggers (enter/step) — see TriggerSchema. */
  triggers: z.array(TriggerSchema).optional(),
});
export type MapDef = z.infer<typeof MapDefSchema>;

export const InventoryEntrySchema = z.object({
  itemId: z.string().min(1),
  qty: z.number().int().min(1, "qty must be at least 1"),
});
export type InventoryEntry = z.infer<typeof InventoryEntrySchema>;

export const GameSchema = z.object({
  meta: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    version: z.string().default("0.1.0"),
    goal: z.string().describe("One sentence telling the player what winning means"),
  }),
  /** The creature catalog: type chart, moves, species, items. One document,
   *  one truth — encounter tables and commands are checked against it.
   *  OPTIONAL: a game without a catalog is a narrative game — no battles,
   *  party, items, or encounters (validation errors name each conflict). */
  catalog: CatalogSchema.optional(),
  /** Map row characters -> tile definitions. Keys must be exactly one character.
   *  Shared by every map. */
  legend: z.record(z.string(), TileSchema),
  /** Named maps (towns, routes, interiors) connected by portals. */
  maps: z.record(z.string().min(1), MapDefSchema),
  player: z.object({
    glyph: z.string().min(1),
    map: z.string().min(1).describe("Id of the map the player starts on"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    /** Starting party (up to 6). Games can instead grant creatures via
     *  give_species interactions (e.g. starter pedestals). */
    party: z.array(PartyMemberSchema).max(6).default([]),
    money: z.number().int().nonnegative().default(0),
    inventory: z.array(InventoryEntrySchema).default([]),
    /** Where the player wakes after a whole-party defeat.
     *  Defaults to the start position. */
    respawn: z
      .object({
        map: z.string().min(1),
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});

export type Game = z.infer<typeof GameSchema>;

export interface ValidationResult {
  ok: boolean;
  game?: Game;
  errors: string[];
  /** Non-fatal issues worth fixing (the game still loads). */
  warnings: string[];
  /** Every ending id the game can reach (`end` command ids; a `win` command
   *  contributes "victory"), sorted. Present on successful validation. */
  endings?: string[];
}

function charLength(s: string): number {
  return [...s].length; // count code points so emoji legend keys work
}

/**
 * Full validation: zod structure first, then cross-references
 * (legend coverage, bounds, walkability, portals, encounter zones,
 * id uniqueness). Every error is written so the author knows what to change.
 */
export function validateGame(data: unknown): ValidationResult {
  const parsed = GameSchema.safeParse(data);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    return { ok: false, errors, warnings: [] };
  }
  const game = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Catalog cross-references (type chart, learnsets, evolutions, items).
  // No catalog = narrative game: every battle-dependent feature below errors
  // with a message naming the fix.
  const hasCatalog = game.catalog !== undefined;
  if (game.catalog) {
    const catalogResult = validateCatalog(game.catalog);
    for (const e of catalogResult.errors) errors.push(`catalog.${e}`);
  }
  const speciesIds = new Set((game.catalog?.species ?? []).map((s) => s.id));
  const itemIds = new Set((game.catalog?.items ?? []).map((i) => i.id));
  const noCatalogFix = (feature: string, fix: string) =>
    `${feature} needs a creature catalog, but this game has none — ${fix}, or add a top-level "catalog" (typeChart, moves, species)`;
  const speciesList = () => [...speciesIds].join(", ");
  const itemList = () =>
    itemIds.size > 0 ? [...itemIds].join(", ") : "(none defined — add items to the catalog)";

  for (const key of Object.keys(game.legend)) {
    if (charLength(key) !== 1) {
      errors.push(
        `legend: key "${key}" must be exactly one character (it indexes map row characters)`,
      );
    }
  }

  const mapIds = Object.keys(game.maps);
  if (mapIds.length === 0) {
    errors.push(`maps: define at least one map — e.g. "maps": { "village": { "rows": [...] } }`);
    return { ok: false, errors, warnings };
  }
  const mapList = mapIds.join(", ");

  // First pass: per-map grid structure (ragged rows, unknown chars).
  const grids = new Map<string, string[][]>();
  for (const [mapId, def] of Object.entries(game.maps)) {
    const rows = def.rows.map((r) => [...r]);
    const width = rows[0].length;
    let structural = false;
    rows.forEach((row, y) => {
      if (row.length !== width) {
        structural = true;
        errors.push(
          `maps.${mapId}.rows[${y}]: has ${row.length} characters but row 0 has ${width} — all rows must be the same width`,
        );
      }
      row.forEach((ch, x) => {
        if (!game.legend[ch]) {
          structural = true;
          errors.push(
            `maps.${mapId}.rows[${y}] column ${x}: character "${ch}" is not in the legend — add it to legend or fix the map`,
          );
        }
      });
    });
    if (!structural) grids.set(mapId, rows);
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  const inBounds = (mapId: string, x: number, y: number) => {
    const rows = grids.get(mapId)!;
    return x >= 0 && x < rows[0].length && y >= 0 && y < rows.length;
  };
  const tileAt = (mapId: string, x: number, y: number) =>
    game.legend[grids.get(mapId)![y][x]];

  const checkPos = (label: string, mapId: string, x: number, y: number) => {
    const rows = grids.get(mapId)!;
    if (!inBounds(mapId, x, y)) {
      errors.push(
        `${label}: position (${x}, ${y}) is outside the ${rows[0].length}x${rows.length} map "${mapId}"`,
      );
      return false;
    }
    if (!tileAt(mapId, x, y).walkable) {
      errors.push(
        `${label}: position (${x}, ${y}) on map "${mapId}" is on non-walkable tile "${tileAt(mapId, x, y).name}"`,
      );
      return false;
    }
    return true;
  };

  // Player start.
  if (!game.maps[game.player.map]) {
    errors.push(
      `player.map: "${game.player.map}" is not a defined map — use one of: ${mapList}`,
    );
  } else {
    checkPos("player", game.player.map, game.player.x, game.player.y);
  }

  // Flag/var read-write bookkeeping, for the warning pass at the end.
  const flagReads = new Set<string>();
  const flagWrites = new Set<string>();
  const varReads = new Set<string>();
  const varWrites = new Set<string>();
  const varSetNumber = new Set<string>(); // set_var with a number value
  const varSetString = new Set<string>(); // set_var with a string value
  const addVarSites = new Map<string, string[]>(); // var -> add_var labels

  const collectWhen = (when: When): void => {
    if ("flag" in when) flagReads.add(when.flag);
    else if ("notFlag" in when) flagReads.add(when.notFlag);
    else if ("all" in when) when.all.forEach(collectWhen);
    else if ("any" in when) when.any.forEach(collectWhen);
    else if ("not" in when) collectWhen(when.not);
    else if (when.var !== "money") varReads.add(when.var); // "money" is built-in
  };

  // Cross-list bookkeeping for the new narrative commands: entity references
  // (move_entity, remove_entity, camera_focus, set_variant) are resolved after
  // every map — and every spawn_entity payload — has been seen.
  const endingIds = new Set<string>();
  const entityRefs: { label: string; id: string; variantId?: string }[] = [];
  const spawnCmds: { label: string; entity: EntityDef }[] = [];
  const spawnedDefs = new Map<string, EntityDef>(); // first spawn wins
  const staticEntityDefs = new Map<string, Entity>();

  // Command lists (interactions and trainer rewardCommands) share one checker.
  // `battleSide` marks lists that run from a battle (trainer rewardCommands):
  // `choice` is overworld-only and errors there. Recurses into choice options.
  const checkCommands = (label: string, commands: Command[], battleSide = false) => {
    const winIdx = commands.findIndex((c) => c.type === "win");
    if (winIdx !== -1 && winIdx !== commands.length - 1) {
      errors.push(`${label}: "win" must be the last command — commands after it never run`);
    }
    const endIdx = commands.findIndex((c) => c.type === "end" && !c.when);
    if (endIdx !== -1 && endIdx !== commands.length - 1) {
      errors.push(
        `${label}: an ungated "end" must be the last command — commands after it never run; add a "when" to make it conditional, or move it last`,
      );
    }
    for (const [j, cmd] of commands.entries()) {
      if (cmd.when) collectWhen(cmd.when);
      if (cmd.type === "choice") {
        if (battleSide) {
          errors.push(
            `${label}[${j}]: "choice" can't run from a battle — rewardCommands run at battle end; move the choice into the trainer's post-defeat interactions`,
          );
        }
        if (cmd.options.every((o) => o.when !== undefined)) {
          warnings.push(
            `${label}[${j}]: every option of this choice is when-gated — if none pass, the choice is skipped at runtime; add an ungated option (no "when") as a guaranteed fallback, or make sure some gate always passes`,
          );
        }
        for (const [k, option] of cmd.options.entries()) {
          if (option.when) collectWhen(option.when);
          checkCommands(`${label}[${j}].options[${k}].commands`, option.commands, battleSide);
        }
      }
      if (cmd.type === "set_flag") flagWrites.add(cmd.flag);
      if (cmd.type === "set_var" || cmd.type === "add_var") {
        if (cmd.var === "money") {
          errors.push(
            `${label}[${j}]: "money" is the built-in money counter and can't be written as a var — use give_money (or sell) to change money, or pick another var name`,
          );
        }
        varWrites.add(cmd.var);
      }
      if (cmd.type === "set_var") {
        (typeof cmd.value === "number" ? varSetNumber : varSetString).add(cmd.var);
      }
      if (cmd.type === "add_var") {
        const sites = addVarSites.get(cmd.var) ?? [];
        sites.push(`${label}[${j}]`);
        addVarSites.set(cmd.var, sites);
      }
      if (cmd.type === "give_species") {
        if (!hasCatalog) {
          errors.push(
            `${label}[${j}]: ${noCatalogFix("give_species", "remove this command")}`,
          );
        } else if (!speciesIds.has(cmd.speciesId)) {
          errors.push(
            `${label}[${j}]: speciesId "${cmd.speciesId}" is not in the catalog — use one of: ${speciesList()}`,
          );
        }
      }
      if (cmd.type === "give_item" || cmd.type === "sell") {
        if (!hasCatalog) {
          errors.push(
            `${label}[${j}]: ${noCatalogFix(`${cmd.type} (items live in the catalog)`, "remove this command")}`,
          );
        } else if (!itemIds.has(cmd.itemId)) {
          errors.push(
            `${label}[${j}]: itemId "${cmd.itemId}" is not in the catalog — use one of: ${itemList()}`,
          );
        }
      }
      if (cmd.type === "win") endingIds.add("victory");
      if (cmd.type === "end") endingIds.add(cmd.id);
      if (cmd.type === "teleport_player") {
        if (!game.maps[cmd.mapId]) {
          errors.push(
            `${label}[${j}].mapId: "${cmd.mapId}" is not a defined map — use one of: ${mapList}`,
          );
        } else {
          checkPos(`${label}[${j}]`, cmd.mapId, cmd.x, cmd.y);
        }
      }
      if (cmd.type === "move_entity" || cmd.type === "remove_entity") {
        entityRefs.push({ label: `${label}[${j}]`, id: cmd.entityId });
      }
      if (cmd.type === "set_variant") {
        if ((cmd.variantId !== undefined) === (cmd.clear === true)) {
          errors.push(
            `${label}[${j}]: set_variant needs exactly one of "variantId" (force a variant) or "clear": true (return to when-evaluation)`,
          );
        }
        entityRefs.push({
          label: `${label}[${j}]`,
          id: cmd.entityId,
          ...(cmd.variantId !== undefined ? { variantId: cmd.variantId } : {}),
        });
      }
      if (cmd.type === "camera_focus") {
        const targets = [
          cmd.entityId !== undefined,
          cmd.x !== undefined || cmd.y !== undefined,
          cmd.release === true,
        ].filter(Boolean).length;
        if (targets !== 1) {
          errors.push(
            `${label}[${j}]: camera_focus needs exactly one target — { entityId }, { mapId?, x, y }, or { release: true }`,
          );
        } else if (cmd.entityId !== undefined) {
          if (cmd.mapId !== undefined) {
            errors.push(
              `${label}[${j}]: camera_focus with entityId doesn't take mapId — the camera follows the entity wherever it is`,
            );
          }
          entityRefs.push({ label: `${label}[${j}]`, id: cmd.entityId });
        } else if (cmd.release !== true) {
          if (cmd.x === undefined || cmd.y === undefined) {
            errors.push(`${label}[${j}]: camera_focus on a tile needs both x and y`);
          } else if (cmd.mapId !== undefined) {
            if (!game.maps[cmd.mapId]) {
              errors.push(
                `${label}[${j}].mapId: "${cmd.mapId}" is not a defined map — use one of: ${mapList}`,
              );
            } else if (!inBounds(cmd.mapId, cmd.x, cmd.y)) {
              const rows = grids.get(cmd.mapId)!;
              errors.push(
                `${label}[${j}]: (${cmd.x}, ${cmd.y}) is outside the ${rows[0].length}x${rows.length} map "${cmd.mapId}"`,
              );
            }
          }
          // mapId omitted = current map at runtime — bounds unknowable here.
        }
      }
      if (cmd.type === "set_tile") {
        if (charLength(cmd.char) !== 1) {
          errors.push(
            `${label}[${j}].char: "${cmd.char}" must be exactly one character (a legend key)`,
          );
        } else if (!game.legend[cmd.char]) {
          errors.push(
            `${label}[${j}].char: "${cmd.char}" is not in the legend — add it to legend or use one of: ${Object.keys(game.legend).join(" ")}`,
          );
        }
        if (cmd.mapId !== undefined) {
          if (!game.maps[cmd.mapId]) {
            errors.push(
              `${label}[${j}].mapId: "${cmd.mapId}" is not a defined map — use one of: ${mapList}`,
            );
          } else if (!inBounds(cmd.mapId, cmd.x, cmd.y)) {
            const rows = grids.get(cmd.mapId)!;
            errors.push(
              `${label}[${j}]: (${cmd.x}, ${cmd.y}) is outside the ${rows[0].length}x${rows.length} map "${cmd.mapId}"`,
            );
          }
        }
      }
      if (cmd.type === "spawn_entity") {
        if (cmd.mapId !== undefined) {
          if (!game.maps[cmd.mapId]) {
            errors.push(
              `${label}[${j}].mapId: "${cmd.mapId}" is not a defined map — use one of: ${mapList}`,
            );
          } else if (!inBounds(cmd.mapId, cmd.entity.x, cmd.entity.y)) {
            const rows = grids.get(cmd.mapId)!;
            errors.push(
              `${label}[${j}].entity: position (${cmd.entity.x}, ${cmd.entity.y}) is outside the ${rows[0].length}x${rows.length} map "${cmd.mapId}"`,
            );
          }
        }
        spawnCmds.push({ label: `${label}[${j}]`, entity: cmd.entity });
        if (!spawnedDefs.has(cmd.entity.id)) spawnedDefs.set(cmd.entity.id, cmd.entity);
        // The spawned entity's interactions run overworld-side regardless of
        // where the spawn command itself sits.
        checkEntityContent(`${label}[${j}].entity`, cmd.entity as Entity);
      }
    }
  };

  /** Shared checks for an entity's CONTENT (gates, dialogue, trainer,
   *  variants) — used for placed entities and spawn_entity payloads alike.
   *  Position and id-uniqueness checks stay with the placed-entity loop. */
  const checkEntityContent = (label: string, e: Entity) => {
    if (e.passableWithFlag) flagReads.add(e.passableWithFlag);
    if (e.variants) {
      const seenVariants = new Set<string>();
      for (const [vi, v] of e.variants.entries()) {
        if (seenVariants.has(v.id)) {
          errors.push(
            `${label}.variants[${vi}]: duplicate variant id "${v.id}" — variant ids must be unique per entity`,
          );
        }
        seenVariants.add(v.id);
        if (v.when) collectWhen(v.when);
      }
    }
    for (const [i, interaction] of e.interactions.entries()) {
      if (interaction.requiresFlag) flagReads.add(interaction.requiresFlag);
      if (interaction.forbidsFlag) flagReads.add(interaction.forbidsFlag);
      if (interaction.when) collectWhen(interaction.when);
      checkCommands(`${label}.interactions[${i}].commands`, interaction.commands);
    }
    if (e.trainer) {
      // The defeatFlag is set by the engine on victory — it counts as a write.
      flagWrites.add(e.trainer.defeatFlag);
      const tLabel = `${label}.trainer`;
      if (!hasCatalog) {
        errors.push(
          `${tLabel}: ${noCatalogFix("a trainer (battles use catalog species)", "remove the trainer block")}`,
        );
      }
      for (const [i, member] of e.trainer.party.entries()) {
        if (hasCatalog && !speciesIds.has(member.speciesId)) {
          errors.push(
            `${tLabel}.party[${i}]: speciesId "${member.speciesId}" is not in the catalog — use one of: ${speciesList()}`,
          );
        }
      }
      if (e.trainer.rewardCommands) {
        checkCommands(`${tLabel}.rewardCommands`, e.trainer.rewardCommands, true);
      }
    }
  };

  // Entities: ids unique game-wide, positions unique per map.
  const seenIds = new Map<string, string>(); // id -> mapId
  for (const [mapId, def] of Object.entries(game.maps)) {
    const seenPos = new Map<string, string>();
    if (mapId === game.player.map) {
      seenPos.set(`${game.player.x},${game.player.y}`, "player");
    }
    for (const e of def.entities) {
      const priorMap = seenIds.get(e.id);
      if (priorMap !== undefined) {
        errors.push(
          `maps.${mapId}.entities: duplicate id "${e.id}" (already used on map "${priorMap}") — entity ids must be unique across the whole game`,
        );
      }
      seenIds.set(e.id, mapId);
      if (!staticEntityDefs.has(e.id)) staticEntityDefs.set(e.id, e);
      if (checkPos(`maps.${mapId}.entities.${e.id}`, mapId, e.x, e.y)) {
        const key = `${e.x},${e.y}`;
        const other = seenPos.get(key);
        if (other) {
          errors.push(
            `maps.${mapId}.entities.${e.id}: position (${e.x}, ${e.y}) is already occupied by ${other}`,
          );
        }
        seenPos.set(key, e.id);
      }
      checkEntityContent(`maps.${mapId}.entities.${e.id}`, e);
    }
  }

  // Triggers: unique ids per map, step tiles present and in bounds, commands
  // recursed through the same checker as interactions.
  for (const [mapId, def] of Object.entries(game.maps)) {
    const seenTriggers = new Set<string>();
    for (const [i, t] of (def.triggers ?? []).entries()) {
      const label = `maps.${mapId}.triggers[${i}]`;
      if (seenTriggers.has(t.id)) {
        errors.push(
          `${label}: duplicate trigger id "${t.id}" — trigger ids must be unique per map`,
        );
      }
      seenTriggers.add(t.id);
      if (t.on === "step") {
        if (!t.tiles) {
          errors.push(
            `${label}: a "step" trigger needs "tiles" — list the { x, y } tiles that fire it`,
          );
        } else {
          for (const [ti, tile] of t.tiles.entries()) {
            if (!inBounds(mapId, tile.x, tile.y)) {
              const rows = grids.get(mapId)!;
              errors.push(
                `${label}.tiles[${ti}]: (${tile.x}, ${tile.y}) is outside the ${rows[0].length}x${rows.length} map "${mapId}"`,
              );
            } else if (!tileAt(mapId, tile.x, tile.y).walkable) {
              warnings.push(
                `${label}.tiles[${ti}]: (${tile.x}, ${tile.y}) is on non-walkable tile "${tileAt(mapId, tile.x, tile.y).name}" — the player can never land there, so the trigger can't fire (unless a set_tile makes it walkable)`,
              );
            }
          }
        }
      } else if (t.tiles) {
        errors.push(
          `${label}: "tiles" only applies to "step" triggers — remove tiles or set "on": "step"`,
        );
      }
      if (t.when) collectWhen(t.when);
      checkCommands(`${label}.commands`, t.commands);
    }
  }

  // Portals: source and destination in-bounds and walkable, one per tile.
  for (const [mapId, def] of Object.entries(game.maps)) {
    const portalTiles = new Map<string, number>();
    for (const [i, p] of def.portals.entries()) {
      const label = `maps.${mapId}.portals[${i}]`;
      if (!inBounds(mapId, p.x, p.y)) {
        const rows = grids.get(mapId)!;
        errors.push(
          `${label}: source (${p.x}, ${p.y}) is outside the ${rows[0].length}x${rows.length} map "${mapId}" — move the portal onto the map`,
        );
      } else if (!tileAt(mapId, p.x, p.y).walkable) {
        errors.push(
          `${label}: source (${p.x}, ${p.y}) is on non-walkable tile "${tileAt(mapId, p.x, p.y).name}" — the player must be able to step onto a portal`,
        );
      } else {
        const key = `${p.x},${p.y}`;
        const prior = portalTiles.get(key);
        if (prior !== undefined) {
          errors.push(
            `${label}: tile (${p.x}, ${p.y}) already has portals[${prior}] on it — only one portal per tile`,
          );
        }
        portalTiles.set(key, i);
      }
      if (!game.maps[p.toMap]) {
        errors.push(
          `${label}.toMap: "${p.toMap}" is not a defined map — use one of: ${mapList}`,
        );
      } else if (!inBounds(p.toMap, p.toX, p.toY)) {
        const rows = grids.get(p.toMap)!;
        errors.push(
          `${label}: destination (${p.toX}, ${p.toY}) is outside the ${rows[0].length}x${rows.length} map "${p.toMap}" — move the destination onto the map`,
        );
      } else if (!tileAt(p.toMap, p.toX, p.toY).walkable) {
        errors.push(
          `${label}: destination (${p.toX}, ${p.toY}) on map "${p.toMap}" is on non-walkable tile "${tileAt(p.toMap, p.toX, p.toY).name}" — the player must land on a walkable tile`,
        );
      }
    }
  }

  // Encounter zones vs wild tiles.
  for (const [mapId, def] of Object.entries(game.maps)) {
    const rows = grids.get(mapId)!;
    const wildTiles = new Set<string>();
    for (const row of rows) {
      for (const ch of row) {
        if (game.legend[ch].wild) wildTiles.add(game.legend[ch].name);
      }
    }
    if (!hasCatalog) {
      if (wildTiles.size > 0) {
        errors.push(
          `maps.${mapId}: has wild tiles (${[...wildTiles].map((n) => `"${n}"`).join(", ")}) — ${noCatalogFix("wild encounters", "remove the wild tiles (or their \"wild\": true)")}`,
        );
      }
      if (def.encounters) {
        errors.push(
          `maps.${mapId}.encounters: ${noCatalogFix("an encounter zone", "remove the encounters zone")}`,
        );
      }
      continue;
    }
    if (wildTiles.size > 0 && !def.encounters) {
      errors.push(
        `maps.${mapId}: has wild tiles (${[...wildTiles].map((n) => `"${n}"`).join(", ")}) but no encounters zone — add maps.${mapId}.encounters with a rate and a species table, or remove the wild tiles`,
      );
    }
    if (wildTiles.size === 0 && def.encounters) {
      warnings.push(
        `maps.${mapId}.encounters: defined but the map has no wild tiles — encounters will never trigger; add tiles with "wild": true to the map or remove the zone`,
      );
    }
    if (def.encounters) {
      for (const [i, entry] of def.encounters.table.entries()) {
        if (entry.minLevel > entry.maxLevel) {
          errors.push(
            `maps.${mapId}.encounters.table[${i}]: minLevel ${entry.minLevel} is greater than maxLevel ${entry.maxLevel} — swap or adjust them`,
          );
        }
        if (!speciesIds.has(entry.speciesId)) {
          errors.push(
            `maps.${mapId}.encounters.table[${i}]: speciesId "${entry.speciesId}" is not in the catalog — use one of: ${speciesList()}`,
          );
        }
      }
    }
  }

  // Player party, inventory, respawn.
  if (!hasCatalog && game.player.party.length > 0) {
    errors.push(
      `player.party: ${noCatalogFix("a starting party", 'set "party": []')}`,
    );
  }
  if (!hasCatalog && game.player.inventory.length > 0) {
    errors.push(
      `player.inventory: ${noCatalogFix("starting items (items live in the catalog)", 'set "inventory": []')}`,
    );
  }
  for (const [i, member] of game.player.party.entries()) {
    if (hasCatalog && !speciesIds.has(member.speciesId)) {
      errors.push(
        `player.party[${i}]: speciesId "${member.speciesId}" is not in the catalog — use one of: ${speciesList()}`,
      );
    }
  }
  for (const [i, entry] of game.player.inventory.entries()) {
    if (hasCatalog && !itemIds.has(entry.itemId)) {
      errors.push(
        `player.inventory[${i}]: itemId "${entry.itemId}" is not in the catalog — use one of: ${itemList()}`,
      );
    }
  }
  if (game.player.respawn) {
    const r = game.player.respawn;
    if (!game.maps[r.map]) {
      errors.push(
        `player.respawn.map: "${r.map}" is not a defined map — use one of: ${mapList}`,
      );
    } else {
      checkPos("player.respawn", r.map, r.x, r.y);
    }
  }

  // Entity references from commands, resolved once every placed entity and
  // spawn_entity payload has been seen (a command may reference an entity it
  // spawns later in the same list, or that another list spawns).
  const knownEntityIdList = () => {
    const ids = [...new Set([...staticEntityDefs.keys(), ...spawnedDefs.keys()])];
    return ids.length > 0 ? ids.join(", ") : "(none defined)";
  };
  for (const ref of entityRefs) {
    const def = staticEntityDefs.get(ref.id) ?? spawnedDefs.get(ref.id);
    if (!def) {
      errors.push(
        `${ref.label}: entityId "${ref.id}" is not a defined entity (and no spawn_entity creates it) — use one of: ${knownEntityIdList()}`,
      );
      continue;
    }
    if (ref.variantId !== undefined) {
      const variantIds = (def.variants ?? []).map((v) => v.id);
      if (!variantIds.includes(ref.variantId)) {
        errors.push(
          `${ref.label}: variantId "${ref.variantId}" is not a variant of "${ref.id}" — ${
            variantIds.length > 0
              ? `use one of: ${variantIds.join(", ")}`
              : `"${ref.id}" defines no variants; add a "variants" array to the entity`
          }`,
        );
      }
    }
  }
  // A spawned id colliding with a placed entity can never succeed at runtime.
  for (const s of spawnCmds) {
    const priorMap = seenIds.get(s.entity.id);
    if (priorMap !== undefined) {
      errors.push(
        `${s.label}: entity id "${s.entity.id}" already exists on map "${priorMap}" — spawned ids must not collide with placed entities; pick another id`,
      );
    }
  }

  // add_var on a var that is only ever set to text is statically wrong.
  for (const [v, sites] of addVarSites) {
    if (varSetString.has(v) && !varSetNumber.has(v)) {
      for (const site of sites) {
        errors.push(
          `${site}: add_var needs "${v}" to hold a number, but every set_var writes "${v}" as text — set_var it to a number, or change those writes`,
        );
      }
    }
  }

  // Read-never-written checks are WARNINGS: the game loads, but a condition
  // that can never change state is usually a typo'd name.
  for (const v of [...varReads].sort()) {
    if (!varWrites.has(v)) {
      warnings.push(
        `vars: "${v}" is read in a when condition but never written — conditions will always see 0 (or "" against text); add a set_var/add_var, or fix the var name`,
      );
    }
  }
  for (const f of [...flagReads].sort()) {
    if (!flagWrites.has(f)) {
      warnings.push(
        `flags: "${f}" is read (requiresFlag, forbidsFlag, passableWithFlag, or a when condition) but never set — no set_flag or trainer defeatFlag writes it, so the gate can never change; add a writer, or fix the flag name`,
      );
    }
  }

  return errors.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, game, errors: [], warnings, endings: [...endingIds].sort() };
}
