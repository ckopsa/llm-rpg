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

export const CommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("say"), text: z.string().min(1) }),
  z.object({ type: z.literal("set_flag"), flag: z.string().min(1) }),
  z.object({ type: z.literal("win"), text: z.string().min(1) }),
  /** Add a creature to the party (fails with an event if the party is full).
   *  Starter choice is spatial: three pedestal entities each give a different
   *  starter and set a shared flag like "starter_chosen" via forbidsFlag gates. */
  z.object({
    type: z.literal("give_species"),
    speciesId: z.string().min(1),
    level: z.number().int().min(1, "level must be at least 1"),
  }),
  z.object({
    type: z.literal("give_item"),
    itemId: z.string().min(1),
    qty: z.number().int().min(1, "qty must be at least 1"),
  }),
  z.object({
    type: z.literal("give_money"),
    amount: z.number().int().min(1, "amount must be at least 1"),
  }),
  /** Heal-hearth: restores every party member's HP and PP. */
  z.object({ type: z.literal("heal_party") }),
  /** Shop counter: the player BUYS 1x itemId for `price` coins (deducted on
   *  success; a failure event names the shortfall). Shops are spatial — one
   *  shopkeeper/counter entity (or one interaction) per item, no menu system. */
  z.object({
    type: z.literal("sell"),
    itemId: z.string().min(1),
    price: z.number().int().min(0, "price must be zero or more"),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;

export const InteractionSchema = z.object({
  requiresFlag: z.string().optional(),
  /** Interaction is SKIPPED if this flag is set — for one-time gifts
   *  (e.g. starter pedestals that all check "starter_chosen"). */
  forbidsFlag: z.string().optional(),
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

export const MapDefSchema = z.object({
  rows: z.array(z.string().min(1)).min(1),
  entities: z.array(EntitySchema).default([]),
  portals: z.array(PortalSchema).default([]),
  /** Wild-encounter table for this map's `wild` tiles. */
  encounters: EncounterZoneSchema.optional(),
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
   *  one truth — encounter tables and commands are checked against it. */
  catalog: CatalogSchema,
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
  const catalogResult = validateCatalog(game.catalog);
  for (const e of catalogResult.errors) errors.push(`catalog.${e}`);
  const speciesIds = new Set(game.catalog.species.map((s) => s.id));
  const itemIds = new Set(game.catalog.items.map((i) => i.id));
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

  // Command lists (interactions and trainer rewardCommands) share one checker.
  const checkCommands = (label: string, commands: Command[]) => {
    const winIdx = commands.findIndex((c) => c.type === "win");
    if (winIdx !== -1 && winIdx !== commands.length - 1) {
      errors.push(`${label}: "win" must be the last command — commands after it never run`);
    }
    for (const [j, cmd] of commands.entries()) {
      if (cmd.type === "give_species" && !speciesIds.has(cmd.speciesId)) {
        errors.push(
          `${label}[${j}]: speciesId "${cmd.speciesId}" is not in the catalog — use one of: ${speciesList()}`,
        );
      }
      if ((cmd.type === "give_item" || cmd.type === "sell") && !itemIds.has(cmd.itemId)) {
        errors.push(
          `${label}[${j}]: itemId "${cmd.itemId}" is not in the catalog — use one of: ${itemList()}`,
        );
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
      for (const [i, interaction] of e.interactions.entries()) {
        checkCommands(
          `maps.${mapId}.entities.${e.id}.interactions[${i}].commands`,
          interaction.commands,
        );
      }
      if (e.trainer) {
        const tLabel = `maps.${mapId}.entities.${e.id}.trainer`;
        for (const [i, member] of e.trainer.party.entries()) {
          if (!speciesIds.has(member.speciesId)) {
            errors.push(
              `${tLabel}.party[${i}]: speciesId "${member.speciesId}" is not in the catalog — use one of: ${speciesList()}`,
            );
          }
        }
        if (e.trainer.rewardCommands) {
          checkCommands(`${tLabel}.rewardCommands`, e.trainer.rewardCommands);
        }
      }
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
  for (const [i, member] of game.player.party.entries()) {
    if (!speciesIds.has(member.speciesId)) {
      errors.push(
        `player.party[${i}]: speciesId "${member.speciesId}" is not in the catalog — use one of: ${speciesList()}`,
      );
    }
  }
  for (const [i, entry] of game.player.inventory.entries()) {
    if (!itemIds.has(entry.itemId)) {
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

  return errors.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, game, errors: [], warnings };
}
