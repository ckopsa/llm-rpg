import { z } from "zod";
import {
  EncounterZoneSchema,
  EntitySchema,
  InteractionSchema,
  InventoryEntrySchema,
  PartyMemberSchema,
  TileSchema,
  validateGame,
  type ValidationResult,
} from "./schema.js";
import {
  ItemSchema,
  MoveSchema,
  SpeciesSchema,
  TypeChartSchema,
} from "./catalog.js";

/**
 * The Forge: incremental edit operations over a game DRAFT — a plain JSON
 * document that may be temporarily invalid as a whole (a portal to a
 * not-yet-created map is a normal authoring state). Design rules:
 *
 *  - Every operation takes `(doc, args)` and returns a ForgeResult.
 *  - Operations reject only MALFORMED operations (unknown mapId, paint out
 *    of bounds, duplicate id, bad legend char...) via `opErrors`, with
 *    messages that name the fix. On rejection the input doc is returned
 *    unchanged.
 *  - On success a NEW doc is returned (the input is never mutated) and full
 *    `validateGame` runs on it as ADVISORY `validation` — a successful op
 *    may leave the draft globally invalid, and that's fine.
 *  - Key order is kept stable (top-level rebuilt in schema order: meta,
 *    catalog, legend, maps, player) so file diffs stay readable.
 */

export interface ForgeResult {
  /** Whether the operation itself was well-formed and applied. */
  ok: boolean;
  /** The new draft on success; the unchanged input doc on rejection. */
  doc: unknown;
  /** Why the operation was rejected — each message names the fix. */
  opErrors: string[];
  /** Advisory full-document validation of `doc`. A draft mid-authoring is
   *  routinely `ok: false` here even when the operation succeeded. */
  validation: ValidationResult;
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Code points, so emoji legend chars and glyphs behave as one cell. */
function cp(s: string): string[] {
  return [...s];
}

const TOP_KEYS = ["meta", "catalog", "legend", "maps", "player"] as const;

/** Rebuild the top level in schema order; unknown keys keep their order after. */
function orderDoc(doc: unknown): unknown {
  if (!isRec(doc)) return doc;
  const out: Rec = {};
  for (const k of TOP_KEYS) if (k in doc) out[k] = doc[k];
  for (const k of Object.keys(doc)) if (!(k in out)) out[k] = doc[k];
  return out;
}

function rejectOp(doc: unknown, opErrors: string[]): ForgeResult {
  return { ok: false, doc, opErrors, validation: validateGame(doc) };
}

function acceptOp(draft: unknown): ForgeResult {
  const doc = orderDoc(draft);
  return { ok: true, doc, opErrors: [], validation: validateGame(doc) };
}

/** Deep-clone the input so the caller's doc is never mutated. */
function cloneDraft(doc: unknown, errors: string[]): Rec | undefined {
  if (!isRec(doc)) {
    errors.push(
      "doc must be a JSON object — start a draft with createGame({ id, title, goal })",
    );
    return undefined;
  }
  return structuredClone(doc);
}

function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  label: string,
  errors: string[],
): z.infer<S> | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      errors.push(`${label}${path}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

function mapsOf(draft: Rec, errors: string[]): Rec | undefined {
  if (!isRec(draft.maps)) {
    errors.push(
      "doc.maps is missing or not an object — start the draft with createGame, then add maps with createMap",
    );
    return undefined;
  }
  return draft.maps;
}

function legendOf(draft: Rec, errors: string[]): Rec | undefined {
  if (!isRec(draft.legend)) {
    errors.push(
      "doc.legend is missing or not an object — start the draft with createGame, which seeds starter tiles",
    );
    return undefined;
  }
  return draft.legend;
}

function mapNameList(maps: Rec): string {
  const ids = Object.keys(maps);
  return ids.length > 0 ? ids.join(", ") : "(none yet — call createMap first)";
}

function getMapDef(maps: Rec, mapId: string, errors: string[]): Rec | undefined {
  const def = maps[mapId];
  if (!isRec(def)) {
    errors.push(
      `unknown map "${mapId}" — create it with createMap or use one of: ${mapNameList(maps)}`,
    );
    return undefined;
  }
  return def;
}

function rowsOf(def: Rec, mapId: string, errors: string[]): string[] | undefined {
  const rows = def.rows;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r) => typeof r === "string")) {
    errors.push(
      `maps.${mapId}.rows is missing or not a non-empty array of strings — recreate the map with createMap`,
    );
    return undefined;
  }
  return rows as string[];
}

function requireLegendChar(legend: Rec, char: string, label: string, errors: string[]): void {
  if (!(char in legend)) {
    errors.push(
      `${label}: character "${char}" is not in the legend — add it first with addTile or use one of: ${Object.keys(legend).join(" ") || "(legend is empty)"}`,
    );
  }
}

function boundsError(mapId: string, rows: string[], x: number, y: number): string | undefined {
  if (y < 0 || y >= rows.length) {
    return `(${x}, ${y}) is outside map "${mapId}" — y must be 0..${rows.length - 1}`;
  }
  const width = cp(rows[y]).length;
  if (x < 0 || x >= width) {
    return `(${x}, ${y}) is outside map "${mapId}" — x must be 0..${width - 1} on row ${y}`;
  }
  return undefined;
}

interface FoundEntity {
  mapId: string;
  def: Rec;
  index: number;
  entity: Rec;
}

function findEntity(maps: Rec, entityId: string): FoundEntity | undefined {
  for (const [mapId, defU] of Object.entries(maps)) {
    if (!isRec(defU) || !Array.isArray(defU.entities)) continue;
    for (let i = 0; i < defU.entities.length; i++) {
      const e = defU.entities[i];
      if (isRec(e) && e.id === entityId) return { mapId, def: defU, index: i, entity: e };
    }
  }
  return undefined;
}

function allEntityIds(maps: Rec): string[] {
  const ids: string[] = [];
  for (const defU of Object.values(maps)) {
    if (!isRec(defU) || !Array.isArray(defU.entities)) continue;
    for (const e of defU.entities) {
      if (isRec(e) && typeof e.id === "string") ids.push(e.id);
    }
  }
  return ids;
}

function entityIdList(maps: Rec): string {
  const ids = allEntityIds(maps);
  return ids.length > 0 ? ids.join(", ") : "(none yet — call placeEntity first)";
}

function requireUniqueEntityId(maps: Rec, id: string, label: string, errors: string[]): void {
  const found = findEntity(maps, id);
  if (found) {
    errors.push(
      `${label}: entity id "${id}" is already used on map "${found.mapId}" — entity ids must be unique across the whole game; pick another id or use updateEntity`,
    );
  }
}

// ---------------------------------------------------------------------------
// createGame
// ---------------------------------------------------------------------------

const CreateGameArgs = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    goal: z.string().min(1),
  })
  .strict();

/** A minimal draft: meta, empty catalog, starter legend tiles, no maps, a
 *  placeholder player. Deliberately NOT yet valid — build it up with ops. */
export function createGame(args: z.input<typeof CreateGameArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(CreateGameArgs, args, "createGame", errors);
  if (!a) return rejectOp(null, errors);
  const doc: Rec = {
    meta: { id: a.id, title: a.title, version: "0.1.0", goal: a.goal },
    catalog: {
      typeChart: { types: [], effectiveness: {} },
      moves: [],
      species: [],
      items: [],
    },
    legend: {
      ".": { name: "grass", glyph: "🟩", walkable: true, wild: false },
      "#": { name: "tree", glyph: "🌲", walkable: false, wild: false },
      "~": { name: "water", glyph: "🟦", walkable: false, wild: false },
      "*": { name: "tall grass", glyph: "🌿", walkable: true, wild: true },
    },
    maps: {},
    player: { glyph: "🙂", map: "", x: 0, y: 0, party: [], money: 0, inventory: [] },
  };
  return acceptOp(doc);
}

// ---------------------------------------------------------------------------
// Maps and painting
// ---------------------------------------------------------------------------

const CreateMapArgs = z
  .object({
    mapId: z.string().min(1),
    width: z.number().int().min(1, "width must be at least 1"),
    height: z.number().int().min(1, "height must be at least 1"),
    fill: z.string().min(1),
  })
  .strict();

/** A new width x height map filled with one legend char. Borders are NOT
 *  auto-added — paint them (e.g. paintRect the edges with "#"). */
export function createMap(doc: unknown, args: z.input<typeof CreateMapArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(CreateMapArgs, args, "createMap", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const legend = legendOf(draft, errors);
  if (a.fill !== undefined && cp(a.fill).length !== 1) {
    errors.push(`createMap.fill: "${a.fill}" must be exactly one character (a legend key)`);
  } else if (legend) {
    requireLegendChar(legend, a.fill, "createMap.fill", errors);
  }
  if (!isRec(draft.maps)) draft.maps = {};
  const maps = draft.maps as Rec;
  if (a.mapId in maps) {
    errors.push(
      `map "${a.mapId}" already exists — pick a new id, or edit it with paintRect/paintCells`,
    );
  }
  if (errors.length > 0) return rejectOp(doc, errors);
  maps[a.mapId] = {
    rows: Array.from({ length: a.height }, () => a.fill.repeat(a.width)),
    entities: [],
    portals: [],
  };
  return acceptOp(draft);
}

function setCell(rows: string[], x: number, y: number, char: string): void {
  const cells = cp(rows[y]);
  cells[x] = char;
  rows[y] = cells.join("");
}

const PaintRectArgs = z
  .object({
    mapId: z.string().min(1),
    x1: z.number().int(),
    y1: z.number().int(),
    x2: z.number().int(),
    y2: z.number().int(),
    char: z.string().min(1),
  })
  .strict();

/** Fill the inclusive rectangle (x1,y1)-(x2,y2) with a legend char.
 *  Corners may be given in any order; every cell must be in bounds. */
export function paintRect(doc: unknown, args: z.input<typeof PaintRectArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(PaintRectArgs, args, "paintRect", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  const legend = legendOf(draft, errors);
  const def = maps ? getMapDef(maps, a.mapId, errors) : undefined;
  const rows = def ? rowsOf(def, a.mapId, errors) : undefined;
  if (cp(a.char).length !== 1) {
    errors.push(`paintRect.char: "${a.char}" must be exactly one character (a legend key)`);
  } else if (legend) {
    requireLegendChar(legend, a.char, "paintRect.char", errors);
  }
  if (errors.length > 0 || !rows) return rejectOp(doc, errors);
  const [xa, xb] = a.x1 <= a.x2 ? [a.x1, a.x2] : [a.x2, a.x1];
  const [ya, yb] = a.y1 <= a.y2 ? [a.y1, a.y2] : [a.y2, a.y1];
  for (const [cx, cy] of [
    [xa, ya],
    [xb, yb],
  ]) {
    const err = boundsError(a.mapId, rows, cx, cy);
    if (err) errors.push(`paintRect: corner ${err}`);
  }
  if (errors.length > 0) return rejectOp(doc, errors);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const err = boundsError(a.mapId, rows, x, y);
      if (err) {
        // Possible on ragged draft rows even when both corners are in bounds.
        errors.push(`paintRect: ${err}`);
        return rejectOp(doc, errors);
      }
      setCell(rows, x, y, a.char);
    }
  }
  return acceptOp(draft);
}

const PaintCellsArgs = z
  .object({
    mapId: z.string().min(1),
    cells: z
      .array(
        z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            char: z.string().min(1),
          })
          .strict(),
      )
      .min(1, "cells needs at least one { x, y, char } entry"),
  })
  .strict();

/** Paint individual cells. All cells are checked first; nothing is painted
 *  unless every cell is in bounds with a known legend char. */
export function paintCells(doc: unknown, args: z.input<typeof PaintCellsArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(PaintCellsArgs, args, "paintCells", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  const legend = legendOf(draft, errors);
  const def = maps ? getMapDef(maps, a.mapId, errors) : undefined;
  const rows = def ? rowsOf(def, a.mapId, errors) : undefined;
  if (rows && legend) {
    for (const [i, cell] of a.cells.entries()) {
      if (cp(cell.char).length !== 1) {
        errors.push(
          `paintCells.cells[${i}].char: "${cell.char}" must be exactly one character (a legend key)`,
        );
        continue;
      }
      requireLegendChar(legend, cell.char, `paintCells.cells[${i}].char`, errors);
      const err = boundsError(a.mapId, rows, cell.x, cell.y);
      if (err) errors.push(`paintCells.cells[${i}]: ${err}`);
    }
  }
  if (errors.length > 0 || !rows) return rejectOp(doc, errors);
  for (const cell of a.cells) setCell(rows, cell.x, cell.y, cell.char);
  return acceptOp(draft);
}

// ---------------------------------------------------------------------------
// Legend tiles
// ---------------------------------------------------------------------------

const AddTileArgs = z
  .object({ char: z.string().min(1), tile: TileSchema.strict() })
  .strict();

/** Add a legend entry. `char` must be a single new character. */
export function addTile(doc: unknown, args: z.input<typeof AddTileArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(AddTileArgs, args, "addTile", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  if (cp(a.char).length !== 1) {
    errors.push(
      `addTile.char: "${a.char}" must be exactly one character (it indexes map row characters)`,
    );
  }
  if (!isRec(draft.legend)) draft.legend = {};
  const legend = draft.legend as Rec;
  if (a.char in legend) {
    const existing = legend[a.char];
    const name = isRec(existing) && typeof existing.name === "string" ? ` ("${existing.name}")` : "";
    errors.push(
      `legend already has "${a.char}"${name} — pick another character, or removeTile it first`,
    );
  }
  if (errors.length > 0) return rejectOp(doc, errors);
  legend[a.char] = a.tile;
  return acceptOp(draft);
}

/** Every map cell still painted with `char`, as "mapId (n cells)" labels. */
function tileUsage(maps: Rec, char: string): string[] {
  const usage: string[] = [];
  for (const [mapId, defU] of Object.entries(maps)) {
    if (!isRec(defU) || !Array.isArray(defU.rows)) continue;
    let count = 0;
    for (const row of defU.rows) {
      if (typeof row !== "string") continue;
      for (const c of cp(row)) if (c === char) count++;
    }
    if (count > 0) usage.push(`maps.${mapId} (${count} cell${count === 1 ? "" : "s"})`);
  }
  return usage;
}

const RemoveTileArgs = z.object({ char: z.string().min(1) }).strict();

/** Remove a legend entry — only if no map still paints it. */
export function removeTile(doc: unknown, args: z.input<typeof RemoveTileArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(RemoveTileArgs, args, "removeTile", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const legend = legendOf(draft, errors);
  if (legend && !(a.char in legend)) {
    errors.push(
      `removeTile: "${a.char}" is not in the legend — use one of: ${Object.keys(legend).join(" ") || "(legend is empty)"}`,
    );
  }
  const usage = isRec(draft.maps) ? tileUsage(draft.maps, a.char) : [];
  if (usage.length > 0) {
    errors.push(
      `removeTile: tile "${a.char}" is still painted on ${usage.join(", ")} — repaint those cells with another tile first`,
    );
  }
  if (errors.length > 0 || !legend) return rejectOp(doc, errors);
  delete legend[a.char];
  return acceptOp(draft);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const PlaceEntityArgs = z
  .object({ mapId: z.string().min(1), entity: EntitySchema.strict() })
  .strict();

/** Add a full entity (optionally with a trainer block) to a map. */
export function placeEntity(doc: unknown, args: z.input<typeof PlaceEntityArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(PlaceEntityArgs, args, "placeEntity", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  const def = maps ? getMapDef(maps, a.mapId, errors) : undefined;
  if (maps) requireUniqueEntityId(maps, a.entity.id, "placeEntity", errors);
  if (errors.length > 0 || !def) return rejectOp(doc, errors);
  if (!Array.isArray(def.entities)) def.entities = [];
  (def.entities as unknown[]).push(a.entity);
  return acceptOp(draft);
}

const UpdateEntityArgs = z
  .object({ entityId: z.string().min(1), patch: z.record(z.string(), z.unknown()) })
  .strict();

const EntityPatchSchema = EntitySchema.partial().strict();

/** Shallow-merge a patch onto an entity. `patch.mapId` moves it to another
 *  map; `patch.id` renames it (the new id must be unused). */
export function updateEntity(doc: unknown, args: z.input<typeof UpdateEntityArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(UpdateEntityArgs, args, "updateEntity", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  if (!maps) return rejectOp(doc, errors);
  const found = findEntity(maps, a.entityId);
  if (!found) {
    errors.push(
      `updateEntity: unknown entity "${a.entityId}" — use one of: ${entityIdList(maps)}`,
    );
    return rejectOp(doc, errors);
  }
  const { mapId: moveTo, ...fieldPatch } = a.patch as Rec & { mapId?: unknown };
  let targetDef: Rec | undefined;
  if (moveTo !== undefined) {
    if (typeof moveTo !== "string") {
      errors.push(`updateEntity.patch.mapId: must be a string map id`);
    } else if (moveTo !== found.mapId) {
      targetDef = getMapDef(maps, moveTo, errors);
    }
  }
  const parsedPatch = parseWith(EntityPatchSchema, fieldPatch, "updateEntity.patch", errors);
  if (parsedPatch && typeof parsedPatch.id === "string" && parsedPatch.id !== a.entityId) {
    requireUniqueEntityId(maps, parsedPatch.id, "updateEntity.patch.id", errors);
  }
  const merged = { ...found.entity, ...fieldPatch };
  parseWith(EntitySchema, merged, "updateEntity (merged entity)", errors);
  if (errors.length > 0) return rejectOp(doc, errors);
  if (targetDef) {
    (found.def.entities as unknown[]).splice(found.index, 1);
    if (!Array.isArray(targetDef.entities)) targetDef.entities = [];
    (targetDef.entities as unknown[]).push(merged);
  } else {
    (found.def.entities as unknown[])[found.index] = merged;
  }
  return acceptOp(draft);
}

const RemoveEntityArgs = z.object({ entityId: z.string().min(1) }).strict();

export function removeEntity(doc: unknown, args: z.input<typeof RemoveEntityArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(RemoveEntityArgs, args, "removeEntity", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  if (!maps) return rejectOp(doc, errors);
  const found = findEntity(maps, a.entityId);
  if (!found) {
    errors.push(
      `removeEntity: unknown entity "${a.entityId}" — use one of: ${entityIdList(maps)}`,
    );
    return rejectOp(doc, errors);
  }
  (found.def.entities as unknown[]).splice(found.index, 1);
  return acceptOp(draft);
}

const SetDialogueArgs = z
  .object({
    entityId: z.string().min(1),
    interactions: z.array(InteractionSchema.strict()),
  })
  .strict();

/** Replace an entity's whole interactions array (pass [] to clear it). */
export function setDialogue(doc: unknown, args: z.input<typeof SetDialogueArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(SetDialogueArgs, args, "setDialogue", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  if (!maps) return rejectOp(doc, errors);
  const found = findEntity(maps, a.entityId);
  if (!found) {
    errors.push(
      `setDialogue: unknown entity "${a.entityId}" — use one of: ${entityIdList(maps)}`,
    );
    return rejectOp(doc, errors);
  }
  found.entity.interactions = a.interactions;
  return acceptOp(draft);
}

// ---------------------------------------------------------------------------
// Portals, encounters, player
// ---------------------------------------------------------------------------

const PortalEndSchema = z
  .object({
    mapId: z.string().min(1),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();

const LinkPortalArgs = z
  .object({
    from: PortalEndSchema,
    to: PortalEndSchema,
    bidirectional: z.boolean().optional(),
  })
  .strict();

function putPortal(def: Rec, x: number, y: number, toMap: string, toX: number, toY: number): void {
  if (!Array.isArray(def.portals)) def.portals = [];
  const portals = def.portals as unknown[];
  // One portal per tile: replace any portal already on this source tile.
  const kept = portals.filter((p) => !(isRec(p) && p.x === x && p.y === y));
  kept.push({ x, y, toMap, toX, toY });
  def.portals = kept;
}

/** Link `from` -> `to` (and back when bidirectional). The source map must
 *  exist; a dangling `to.mapId` is allowed — it is a normal authoring state
 *  that advisory validation will keep flagging until the map exists. */
export function linkPortal(doc: unknown, args: z.input<typeof LinkPortalArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(LinkPortalArgs, args, "linkPortal", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  const fromDef = maps ? getMapDef(maps, a.from.mapId, errors) : undefined;
  let toDef: Rec | undefined;
  if (a.bidirectional && maps && !isRec(maps[a.to.mapId])) {
    errors.push(
      `linkPortal: bidirectional needs map "${a.to.mapId}" to exist — createMap it first, or drop bidirectional and link the return portal later`,
    );
  } else if (a.bidirectional && maps) {
    toDef = maps[a.to.mapId] as Rec;
  }
  if (errors.length > 0 || !fromDef) return rejectOp(doc, errors);
  putPortal(fromDef, a.from.x, a.from.y, a.to.mapId, a.to.x, a.to.y);
  if (toDef) putPortal(toDef, a.to.x, a.to.y, a.from.mapId, a.from.x, a.from.y);
  return acceptOp(draft);
}

const SetEncountersArgs = z
  .object({
    mapId: z.string().min(1),
    zone: EncounterZoneSchema.strict().nullable(),
  })
  .strict();

/** Set a map's wild-encounter zone, or clear it with `zone: null`. */
export function setEncounters(doc: unknown, args: z.input<typeof SetEncountersArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(SetEncountersArgs, args, "setEncounters", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  const def = maps ? getMapDef(maps, a.mapId, errors) : undefined;
  if (errors.length > 0 || !def) return rejectOp(doc, errors);
  if (a.zone === null) delete def.encounters;
  else def.encounters = a.zone;
  return acceptOp(draft);
}

const SetPlayerStartArgs = z
  .object({
    glyph: z.string().min(1).optional(),
    mapId: z.string().min(1),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    party: z.array(PartyMemberSchema.strict()).max(6).optional(),
    money: z.number().int().nonnegative().optional(),
    inventory: z.array(InventoryEntrySchema.strict()).optional(),
    respawn: z
      .object({
        map: z.string().min(1),
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Set where (and how) the player starts. Omitted optional fields keep their
 *  existing values (or sensible defaults on a fresh draft). */
export function setPlayerStart(
  doc: unknown,
  args: z.input<typeof SetPlayerStartArgs>,
): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(SetPlayerStartArgs, args, "setPlayerStart", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  const maps = mapsOf(draft, errors);
  if (maps) getMapDef(maps, a.mapId, errors);
  if (errors.length > 0) return rejectOp(doc, errors);
  const existing: Rec = isRec(draft.player) ? draft.player : {};
  const player: Rec = {
    glyph: a.glyph ?? existing.glyph ?? "🙂",
    map: a.mapId,
    x: a.x,
    y: a.y,
    party: a.party ?? existing.party ?? [],
    money: a.money ?? existing.money ?? 0,
    inventory: a.inventory ?? existing.inventory ?? [],
  };
  const respawn = a.respawn ?? existing.respawn;
  if (respawn !== undefined) player.respawn = respawn;
  draft.player = player;
  return acceptOp(draft);
}

// ---------------------------------------------------------------------------
// Catalog: species, moves, items, type chart
// ---------------------------------------------------------------------------

type CatalogKey = "species" | "moves" | "items";

/** Get (creating if absent) one of the catalog's entry arrays. */
function catalogArray(draft: Rec, key: CatalogKey, errors: string[]): Rec[] | undefined {
  if (!isRec(draft.catalog)) {
    errors.push(
      "doc.catalog is missing or not an object — start the draft with createGame, which creates an empty catalog",
    );
    return undefined;
  }
  const cat = draft.catalog;
  if (!Array.isArray(cat[key])) cat[key] = [];
  return cat[key] as Rec[];
}

function catalogIdList(entries: Rec[], key: CatalogKey): string {
  const ids = entries.filter((e) => isRec(e) && typeof e.id === "string").map((e) => e.id);
  return ids.length > 0 ? ids.join(", ") : `(none yet — add ${key} to the catalog first)`;
}

/** Walk one command list AND every nested choice-option command list, so
 *  reference checks see commands inside (arbitrarily nested) choices. */
function walkCommandList(
  commands: unknown[],
  label: string,
  fn: (commands: unknown[], label: string) => void,
): void {
  fn(commands, label);
  commands.forEach((c, j) => {
    if (!isRec(c) || c.type !== "choice" || !Array.isArray(c.options)) return;
    c.options.forEach((o, k) => {
      if (isRec(o) && Array.isArray(o.commands)) {
        walkCommandList(o.commands, `${label}[${j}].options[${k}].commands`, fn);
      }
    });
  });
}

/** Every labeled command list in the draft: entity interactions and trainer
 *  rewardCommands, choice options included. Defensive against half-formed
 *  drafts. */
function eachCommandList(draft: Rec, fn: (commands: unknown[], label: string) => void): void {
  if (!isRec(draft.maps)) return;
  for (const [mapId, defU] of Object.entries(draft.maps)) {
    if (!isRec(defU) || !Array.isArray(defU.entities)) continue;
    for (const e of defU.entities) {
      if (!isRec(e)) continue;
      const eid = typeof e.id === "string" ? e.id : "?";
      if (Array.isArray(e.interactions)) {
        e.interactions.forEach((it, i) => {
          if (isRec(it) && Array.isArray(it.commands)) {
            walkCommandList(
              it.commands,
              `maps.${mapId}.entities.${eid}.interactions[${i}].commands`,
              fn,
            );
          }
        });
      }
      if (isRec(e.trainer) && Array.isArray(e.trainer.rewardCommands)) {
        walkCommandList(
          e.trainer.rewardCommands,
          `maps.${mapId}.entities.${eid}.trainer.rewardCommands`,
          fn,
        );
      }
    }
  }
}

function speciesReferences(draft: Rec, speciesId: string): string[] {
  const refs: string[] = [];
  if (isRec(draft.catalog) && Array.isArray(draft.catalog.species)) {
    for (const s of draft.catalog.species) {
      if (isRec(s) && isRec(s.evolvesTo) && s.evolvesTo.speciesId === speciesId && s.id !== speciesId) {
        refs.push(`catalog.species.${String(s.id)}.evolvesTo`);
      }
    }
  }
  if (isRec(draft.maps)) {
    for (const [mapId, defU] of Object.entries(draft.maps)) {
      if (!isRec(defU)) continue;
      if (isRec(defU.encounters) && Array.isArray(defU.encounters.table)) {
        defU.encounters.table.forEach((t, i) => {
          if (isRec(t) && t.speciesId === speciesId) {
            refs.push(`maps.${mapId}.encounters.table[${i}]`);
          }
        });
      }
      if (Array.isArray(defU.entities)) {
        for (const e of defU.entities) {
          if (!isRec(e) || !isRec(e.trainer) || !Array.isArray(e.trainer.party)) continue;
          const eid = typeof e.id === "string" ? e.id : "?";
          e.trainer.party.forEach((m, i) => {
            if (isRec(m) && m.speciesId === speciesId) {
              refs.push(`maps.${mapId}.entities.${eid}.trainer.party[${i}]`);
            }
          });
        }
      }
    }
  }
  eachCommandList(draft, (commands, label) => {
    commands.forEach((c, j) => {
      if (isRec(c) && c.type === "give_species" && c.speciesId === speciesId) {
        refs.push(`${label}[${j}]`);
      }
    });
  });
  if (isRec(draft.player) && Array.isArray(draft.player.party)) {
    draft.player.party.forEach((m, i) => {
      if (isRec(m) && m.speciesId === speciesId) refs.push(`player.party[${i}]`);
    });
  }
  return refs;
}

function moveReferences(draft: Rec, moveId: string): string[] {
  const refs: string[] = [];
  if (isRec(draft.catalog) && Array.isArray(draft.catalog.species)) {
    for (const s of draft.catalog.species) {
      if (!isRec(s) || !Array.isArray(s.learnset)) continue;
      s.learnset.forEach((e, i) => {
        if (isRec(e) && e.moveId === moveId) {
          refs.push(`catalog.species.${String(s.id)}.learnset[${i}]`);
        }
      });
    }
  }
  return refs;
}

function itemReferences(draft: Rec, itemId: string): string[] {
  const refs: string[] = [];
  eachCommandList(draft, (commands, label) => {
    commands.forEach((c, j) => {
      if (isRec(c) && (c.type === "give_item" || c.type === "sell") && c.itemId === itemId) {
        refs.push(`${label}[${j}]`);
      }
    });
  });
  if (isRec(draft.player) && Array.isArray(draft.player.inventory)) {
    draft.player.inventory.forEach((e, i) => {
      if (isRec(e) && e.itemId === itemId) refs.push(`player.inventory[${i}]`);
    });
  }
  return refs;
}

interface CatalogEntryKind {
  key: CatalogKey;
  /** Singular name used in ids and messages: species/move/item. */
  noun: string;
  addOp: string;
  updateOp: string;
  entrySchema: z.ZodTypeAny;
  patchSchema: z.ZodTypeAny;
  references: (draft: Rec, id: string) => string[];
}

const SPECIES_KIND: CatalogEntryKind = {
  key: "species",
  noun: "species",
  addOp: "addSpecies",
  updateOp: "updateSpecies",
  entrySchema: SpeciesSchema.strict(),
  patchSchema: SpeciesSchema.partial().strict(),
  references: speciesReferences,
};
const MOVE_KIND: CatalogEntryKind = {
  key: "moves",
  noun: "move",
  addOp: "addMove",
  updateOp: "updateMove",
  entrySchema: MoveSchema.strict(),
  patchSchema: MoveSchema.partial().strict(),
  references: moveReferences,
};
const ITEM_KIND: CatalogEntryKind = {
  key: "items",
  noun: "item",
  addOp: "addItem",
  updateOp: "updateItem",
  entrySchema: ItemSchema.strict(),
  patchSchema: ItemSchema.partial().strict(),
  references: itemReferences,
};

function addCatalogEntry(doc: unknown, kind: CatalogEntryKind, entry: unknown): ForgeResult {
  const errors: string[] = [];
  const parsed = parseWith(kind.entrySchema, entry, `${kind.addOp}.${kind.noun}`, errors) as
    | Rec
    | undefined;
  const draft = cloneDraft(doc, errors);
  if (!parsed || !draft) return rejectOp(doc, errors);
  const entries = catalogArray(draft, kind.key, errors);
  if (entries && entries.some((e) => isRec(e) && e.id === parsed.id)) {
    errors.push(
      `${kind.addOp}: ${kind.noun} id "${String(parsed.id)}" already exists — pick a new id, or use ${kind.updateOp}`,
    );
  }
  if (errors.length > 0 || !entries) return rejectOp(doc, errors);
  entries.push(parsed);
  return acceptOp(draft);
}

function updateCatalogEntry(
  doc: unknown,
  kind: CatalogEntryKind,
  id: string,
  patch: unknown,
): ForgeResult {
  const errors: string[] = [];
  const draft = cloneDraft(doc, errors);
  if (typeof id !== "string" || id.length === 0) {
    errors.push(`${kind.updateOp}: provide the ${kind.noun} id to update`);
  }
  if (!isRec(patch)) {
    errors.push(`${kind.updateOp}.patch: must be an object of ${kind.noun} fields to change`);
  }
  if (!draft || errors.length > 0) return rejectOp(doc, errors);
  const entries = catalogArray(draft, kind.key, errors);
  if (!entries) return rejectOp(doc, errors);
  const index = entries.findIndex((e) => isRec(e) && e.id === id);
  if (index === -1) {
    errors.push(
      `${kind.updateOp}: unknown ${kind.noun} "${id}" — use one of: ${catalogIdList(entries, kind.key)}`,
    );
    return rejectOp(doc, errors);
  }
  const patchRec = patch as Rec;
  parseWith(kind.patchSchema, patchRec, `${kind.updateOp}.patch`, errors);
  if (typeof patchRec.id === "string" && patchRec.id !== id) {
    if (entries.some((e) => isRec(e) && e.id === patchRec.id)) {
      errors.push(
        `${kind.updateOp}.patch.id: "${String(patchRec.id)}" is already used — ${kind.noun} ids must be unique`,
      );
    }
  }
  const merged = { ...entries[index], ...patchRec };
  parseWith(kind.entrySchema, merged, `${kind.updateOp} (merged ${kind.noun})`, errors);
  if (errors.length > 0) return rejectOp(doc, errors);
  entries[index] = merged;
  return acceptOp(draft);
}

function removeCatalogEntry(
  doc: unknown,
  kind: CatalogEntryKind,
  removeOp: string,
  id: string,
): ForgeResult {
  const errors: string[] = [];
  const draft = cloneDraft(doc, errors);
  if (typeof id !== "string" || id.length === 0) {
    errors.push(`${removeOp}: provide the ${kind.noun} id to remove`);
  }
  if (!draft || errors.length > 0) return rejectOp(doc, errors);
  const entries = catalogArray(draft, kind.key, errors);
  if (!entries) return rejectOp(doc, errors);
  const index = entries.findIndex((e) => isRec(e) && e.id === id);
  if (index === -1) {
    errors.push(
      `${removeOp}: unknown ${kind.noun} "${id}" — use one of: ${catalogIdList(entries, kind.key)}`,
    );
    return rejectOp(doc, errors);
  }
  const refs = kind.references(draft, id);
  if (refs.length > 0) {
    errors.push(
      `${removeOp}: ${kind.noun} "${id}" is still referenced by: ${refs.join(", ")} — update or remove those references first`,
    );
    return rejectOp(doc, errors);
  }
  entries.splice(index, 1);
  return acceptOp(draft);
}

export function addSpecies(doc: unknown, args: { species: unknown }): ForgeResult {
  return addCatalogEntry(doc, SPECIES_KIND, isRec(args) ? args.species : undefined);
}
export function updateSpecies(doc: unknown, args: { speciesId: string; patch: unknown }): ForgeResult {
  const a = isRec(args) ? args : ({} as Rec);
  return updateCatalogEntry(doc, SPECIES_KIND, a.speciesId as string, a.patch);
}
export function removeSpecies(doc: unknown, args: { speciesId: string }): ForgeResult {
  return removeCatalogEntry(doc, SPECIES_KIND, "removeSpecies", (isRec(args) ? args.speciesId : undefined) as string);
}

export function addMove(doc: unknown, args: { move: unknown }): ForgeResult {
  return addCatalogEntry(doc, MOVE_KIND, isRec(args) ? args.move : undefined);
}
export function updateMove(doc: unknown, args: { moveId: string; patch: unknown }): ForgeResult {
  const a = isRec(args) ? args : ({} as Rec);
  return updateCatalogEntry(doc, MOVE_KIND, a.moveId as string, a.patch);
}
export function removeMove(doc: unknown, args: { moveId: string }): ForgeResult {
  return removeCatalogEntry(doc, MOVE_KIND, "removeMove", (isRec(args) ? args.moveId : undefined) as string);
}

export function addItem(doc: unknown, args: { item: unknown }): ForgeResult {
  return addCatalogEntry(doc, ITEM_KIND, isRec(args) ? args.item : undefined);
}
export function updateItem(doc: unknown, args: { itemId: string; patch: unknown }): ForgeResult {
  const a = isRec(args) ? args : ({} as Rec);
  return updateCatalogEntry(doc, ITEM_KIND, a.itemId as string, a.patch);
}
export function removeItem(doc: unknown, args: { itemId: string }): ForgeResult {
  return removeCatalogEntry(doc, ITEM_KIND, "removeItem", (isRec(args) ? args.itemId : undefined) as string);
}

const SetTypeChartArgs = TypeChartSchema.strict();

/** Replace the whole type chart (types list + effectiveness matrix). */
export function setTypeChart(doc: unknown, args: z.input<typeof SetTypeChartArgs>): ForgeResult {
  const errors: string[] = [];
  const a = parseWith(SetTypeChartArgs, args, "setTypeChart", errors);
  const draft = cloneDraft(doc, errors);
  if (!a || !draft) return rejectOp(doc, errors);
  if (!isRec(draft.catalog)) {
    draft.catalog = { typeChart: a, moves: [], species: [], items: [] };
  } else {
    (draft.catalog as Rec).typeChart = a;
  }
  return acceptOp(draft);
}

// ---------------------------------------------------------------------------
// renderMapAscii — the feedback view an authoring LLM reads after each edit
// ---------------------------------------------------------------------------

/**
 * Render one map as text: the raw row grid with entity glyphs overlaid,
 * portal tiles marked ⇄, the player start marked @, then a one-line key for
 * every entity, portal, and the player start. Read-only; never throws — an
 * unknown map returns an explanatory string.
 */
export function renderMapAscii(doc: unknown, mapId: string): string {
  if (!isRec(doc) || !isRec(doc.maps)) {
    return "no maps to render — start a draft with createGame, then createMap";
  }
  const maps = doc.maps;
  const def = maps[mapId];
  if (!isRec(def)) {
    return `unknown map "${mapId}" — available: ${mapNameList(maps)}`;
  }
  const rows = Array.isArray(def.rows)
    ? def.rows.filter((r): r is string => typeof r === "string")
    : [];
  const grid = rows.map((r) => cp(r));
  const asInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) ? v : undefined;
  const overlay = (xu: unknown, yu: unknown, mark: string): void => {
    const x = asInt(xu);
    const y = asInt(yu);
    if (x !== undefined && y !== undefined && y >= 0 && y < grid.length && x >= 0 && x < grid[y].length) {
      grid[y][x] = mark;
    }
  };

  const lines: string[] = [];
  const portals = Array.isArray(def.portals) ? def.portals.filter(isRec) : [];
  for (const p of portals) overlay(p.x, p.y, "⇄");
  const entities = Array.isArray(def.entities) ? def.entities.filter(isRec) : [];
  for (const e of entities) overlay(e.x, e.y, typeof e.glyph === "string" ? e.glyph : "?");
  const player = isRec(doc.player) ? doc.player : undefined;
  const playerHere = player !== undefined && player.map === mapId;
  if (player && playerHere) overlay(player.x, player.y, "@");

  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  lines.push(`${mapId} — ${width}x${height}`);
  for (const row of grid) lines.push(row.join(""));

  lines.push("");
  if (entities.length > 0) {
    lines.push("Entities:");
    for (const e of entities) {
      const glyph = typeof e.glyph === "string" ? e.glyph : "?";
      const trainer = isRec(e.trainer) ? " [trainer]" : "";
      const blocking = e.blocking === false ? " [non-blocking]" : "";
      lines.push(
        `  ${glyph} ${String(e.id)} "${String(e.name)}" at (${String(e.x)}, ${String(e.y)})${trainer}${blocking}`,
      );
    }
  } else {
    lines.push("Entities: (none)");
  }
  if (portals.length > 0) {
    lines.push("Portals:");
    for (const p of portals) {
      const missing = isRec(maps[String(p.toMap)]) ? "" : " [map does not exist yet]";
      lines.push(
        `  ⇄ (${String(p.x)}, ${String(p.y)}) -> ${String(p.toMap)} (${String(p.toX)}, ${String(p.toY)})${missing}`,
      );
    }
  }
  if (player && playerHere) {
    lines.push(`Player start: @ (${String(player.x)}, ${String(player.y)})`);
  }
  const enc = isRec(def.encounters) ? def.encounters : undefined;
  if (enc && Array.isArray(enc.table)) {
    const table = enc.table
      .filter(isRec)
      .map((t) => `${String(t.speciesId)} Lv${String(t.minLevel)}-${String(t.maxLevel)} (w${String(t.weight)})`)
      .join(", ");
    lines.push(`Encounters: rate ${String(enc.rate)} — ${table}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// applyOps — sequential batch
// ---------------------------------------------------------------------------

export interface ForgeOpCall {
  op: string;
  args?: unknown;
}

export interface ApplyOpsResult extends ForgeResult {
  /** Index of the op that was rejected, or null when every op applied. On
   *  failure `doc` reflects all ops BEFORE the failed one. */
  failedIndex: number | null;
}

/** Registry of every document operation, by name — the applyOps dispatch
 *  table and a discovery surface for authoring tools. */
export const FORGE_OPS: Readonly<Record<string, (doc: unknown, args: never) => ForgeResult>> = {
  createGame: (_doc, args) => createGame(args),
  createMap,
  paintRect,
  paintCells,
  addTile,
  removeTile,
  placeEntity,
  updateEntity,
  removeEntity,
  setDialogue,
  linkPortal,
  setEncounters,
  setPlayerStart,
  addSpecies,
  updateSpecies,
  removeSpecies,
  addMove,
  updateMove,
  removeMove,
  addItem,
  updateItem,
  removeItem,
  setTypeChart,
};

/** Apply ops in order, stopping at the first rejection. The result reports
 *  which index failed (`failedIndex`) with its errors prefixed `ops[i]`. */
export function applyOps(doc: unknown, ops: ForgeOpCall[]): ApplyOpsResult {
  let current = doc;
  for (let i = 0; i < ops.length; i++) {
    const call = ops[i];
    const fn = isRec(call) ? FORGE_OPS[call.op] : undefined;
    if (!fn) {
      const name = isRec(call) ? String(call.op) : String(call);
      const rejected = rejectOp(current, [
        `ops[${i}]: unknown op "${name}" — use one of: ${Object.keys(FORGE_OPS).join(", ")}`,
      ]);
      return { ...rejected, failedIndex: i };
    }
    const result = fn(current, call.args as never);
    if (!result.ok) {
      return {
        ...result,
        opErrors: result.opErrors.map((e) => `ops[${i}] (${call.op}): ${e}`),
        failedIndex: i,
      };
    }
    current = result.doc;
  }
  return { ok: true, doc: current, opErrors: [], validation: validateGame(current), failedIndex: null };
}
