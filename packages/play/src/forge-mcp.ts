import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  FORGE_OPS,
  renderMapAscii,
  validateGame,
  type ForgeOpCall,
  type Game,
  type ValidationResult,
} from "@llm-rpg/engine";
import { analyzeReachability } from "./reachability.js";
import { runExplore, runScript } from "./run.js";
import { resolveUserPath } from "./load.js";
import {
  DEFAULT_GAMES_DIR,
  GAME_FILE,
  applyToFile,
  gameDirOf,
  gameFileOf,
  historyCount,
  listGames,
  newGameFromTemplate,
  readDoc,
  undoLast,
} from "./forge-store.js";

/**
 * MCP Forge server: THE authoring interface for LLMs building games.
 * Wraps the engine's edit-op layer (FORGE_OPS / applyOps) with on-disk
 * persistence: every accepted edit is atomically written to the active
 * game's game.json, with per-write history for forge_undo.
 *
 * Start: tsx src/forge-mcp.ts [gamesDir]   (default: <repo>/games)
 *
 * Recommended loop, spelled out in each tool description:
 *   forge_new_game / forge_open -> forge_edit / forge_batch
 *   -> forge_check after connectivity changes
 *   -> forge_playtest explore before calling content done
 *   -> forge_undo when an accepted edit turns out wrong.
 */

const gamesDir = process.argv[2] ? resolveUserPath(process.argv[2]) : DEFAULT_GAMES_DIR;

/** The game all edit/inspect tools operate on. Set by forge_open/new_game. */
let active: { dirName: string; dir: string } | null = null;

const server = new McpServer({ name: "llm-rpg-forge", version: "0.1.0" });

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MAX_ADVISORY = 15;

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

function text(t: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: t }], isError: true }
    : { content: [{ type: "text", text: t }] };
}

/** Every tool goes through this so a thrown error becomes an isError result
 *  instead of crashing the server. */
function guard(fn: () => string): ToolResult {
  try {
    return text(fn());
  } catch (err) {
    return text((err as Error).message, true);
  }
}

/** Trimmed advisory validation block: errors first, then warnings, capped at
 *  the MAX_ADVISORY most relevant with a pointer to forge_validate. */
function advisoryBlock(v: ValidationResult): string {
  if (v.ok && v.warnings.length === 0) return "validation: OK — the game is fully valid and playable";
  const items = [
    ...v.errors.map((e) => `error: ${e}`),
    ...v.warnings.map((w) => `warning: ${w}`),
  ];
  const shown = items.slice(0, MAX_ADVISORY);
  const hidden = items.length - shown.length;
  const head = v.ok
    ? `validation: OK with ${v.warnings.length} warning(s)`
    : `validation (advisory — drafts may stay invalid while you build): ${v.errors.length} error(s), ${v.warnings.length} warning(s)`;
  return [
    head,
    ...shown.map((s) => `  - ${s}`),
    ...(hidden > 0 ? [`  … +${hidden} more — run forge_validate for the untrimmed list`] : []),
  ].join("\n");
}

function requireActive(): { dirName: string; dir: string } {
  if (!active) {
    throw new Error(
      "no active game — call forge_open { dirName } first (see forge_list_games), or create one with forge_new_game",
    );
  }
  return active;
}

function activeDoc(): unknown {
  const a = requireActive();
  return readDoc(join(a.dir, GAME_FILE));
}

/** Load the active game as a fully validated Game, or throw with the errors
 *  (playtesting and reachability need a valid document). */
function activeGame(): Game {
  const doc = activeDoc();
  const v = validateGame(doc);
  if (!v.ok) {
    throw new Error(
      `the active game is not valid yet, so it can't be simulated — fix these first (forge_validate for the full list):\n${advisoryBlock(v)}`,
    );
  }
  return v.game!;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Which map an op call touches, for the post-edit ASCII render. Entity ops
 *  are resolved by looking the entity up in `doc`. */
function touchedMap(doc: unknown, call: ForgeOpCall): string | undefined {
  const a = isRecord(call.args) ? call.args : undefined;
  if (!a) return undefined;
  if (typeof a.mapId === "string") return a.mapId;
  if (isRecord(a.from) && typeof a.from.mapId === "string") return a.from.mapId;
  const entityId = typeof a.entityId === "string" ? a.entityId : undefined;
  if (entityId && isRecord(doc) && isRecord(doc.maps)) {
    for (const [mapId, def] of Object.entries(doc.maps)) {
      if (isRecord(def) && Array.isArray(def.entities)) {
        if (def.entities.some((e) => isRecord(e) && e.id === entityId)) return mapId;
      }
    }
  }
  return undefined;
}

function mapRenders(doc: unknown, mapIds: (string | undefined)[]): string {
  const unique = [...new Set(mapIds.filter((m): m is string => m !== undefined))];
  return unique
    .slice(0, 3)
    .map((id) => renderMapAscii(doc, id))
    .join("\n\n");
}

const OP_NAMES = Object.keys(FORGE_OPS) as [string, ...string[]];

// ---------------------------------------------------------------------------
// Game management tools
// ---------------------------------------------------------------------------

server.tool(
  "forge_list_games",
  "List every game directory under the games dir (dirs containing game.json), with its meta id/title and whether it currently validates. Directories starting with _ (like _templates) are not games and are excluded. Use forge_open to pick one to edit.",
  {},
  async () =>
    guard(() => {
      const games = listGames(gamesDir);
      if (games.length === 0) {
        return `no games found in ${gamesDir} — create one with forge_new_game`;
      }
      return games
        .map((g) => {
          const status =
            g.errorCount === -1
              ? "UNPARSEABLE JSON"
              : g.valid
                ? "valid"
                : `draft (${g.errorCount} validation error(s))`;
          const label = g.title ? `"${g.title}" (id: ${g.id})` : "(no meta)";
          const mark = active?.dirName === g.dirName ? "  <- active" : "";
          return `${g.dirName}: ${label} — ${status}${mark}`;
        })
        .join("\n");
    }),
);

server.tool(
  "forge_new_game",
  'Create games/<dirName>/game.json (plus sprites.json) from a template and make it the active game. Templates: "starter" (default — a minimal complete, winnable teaching game: 2 maps, 3 species, a flag-gated quest; edit it into your game) or "blank" (a bare draft with meta, starter legend tiles, empty catalog, and NO maps — build everything with forge_edit). Never overwrites an existing directory. The template\'s meta is replaced with your id/title/goal.',
  {
    dirName: z
      .string()
      .describe('Directory name under games/, e.g. "my-quest". Letters/digits/-/_ only.'),
    id: z.string().describe('Game id for meta.id, e.g. "my-quest"'),
    title: z.string().describe("Human-facing title"),
    goal: z.string().describe("One sentence telling the player what winning means"),
    template: z
      .string()
      .optional()
      .describe('"starter" (default) or "blank", or any games/_templates/<name> directory'),
  },
  async ({ dirName, id, title, goal, template }) =>
    guard(() => {
      const created = newGameFromTemplate(gamesDir, { dirName, id, title, goal, template });
      active = { dirName, dir: created.dir };
      const doc = created.doc;
      const startMap =
        isRecord(doc) && isRecord(doc.player) && typeof doc.player.map === "string"
          ? doc.player.map
          : "";
      const mapList = isRecord(doc) && isRecord(doc.maps) ? Object.keys(doc.maps) : [];
      return [
        `created ${created.dir} from template "${template ?? "starter"}" — it is now the active game`,
        advisoryBlock(created.validation),
        `maps: ${mapList.length > 0 ? mapList.join(", ") : "(none yet — createMap first)"}`,
        ...(startMap && mapList.includes(startMap) ? ["", renderMapAscii(doc, startMap)] : []),
      ].join("\n");
    }),
);

server.tool(
  "forge_open",
  "Set the active game (all edit/inspect/playtest tools operate on the active game's games/<dirName>/game.json). Returns a validation summary, the map list, and an ASCII render of the start map. Opening a game that fails validation is fine — drafts are editable.",
  { dirName: z.string().describe("A directory name from forge_list_games") },
  async ({ dirName }) =>
    guard(() => {
      const file = gameFileOf(gamesDir, dirName);
      if (!existsSync(file)) {
        const known = listGames(gamesDir).map((g) => g.dirName);
        throw new Error(
          `${file} does not exist — use one of: ${known.join(", ") || "(no games yet — forge_new_game)"}`,
        );
      }
      const doc = readDoc(file);
      active = { dirName, dir: gameDirOf(gamesDir, dirName) };
      const v = validateGame(doc);
      const mapList = isRecord(doc) && isRecord(doc.maps) ? Object.keys(doc.maps) : [];
      const startMap =
        isRecord(doc) && isRecord(doc.player) && typeof doc.player.map === "string"
          ? doc.player.map
          : "";
      return [
        `opened ${dirName} (${file}) — ${historyCount(active.dir)} undo step(s) available`,
        advisoryBlock(v),
        `maps: ${mapList.length > 0 ? mapList.join(", ") : "(none yet — createMap first)"}`,
        ...(startMap && mapList.includes(startMap) ? ["", renderMapAscii(doc, startMap)] : []),
      ].join("\n");
    }),
);

// ---------------------------------------------------------------------------
// Edit tools
// ---------------------------------------------------------------------------

const EDIT_CONTRACT =
  "An op is REJECTED (nothing written, opErrors name the fix) only when it is malformed: unknown map/entity/id, out-of-bounds paint, duplicate id, unknown legend char. An ACCEPTED op is written to disk immediately even if whole-game validation still fails — those failures are ADVISORY (a portal to a not-yet-created map is a normal draft state; the summary lists what's left to fix). After map/portal edits run forge_check; before calling content done run forge_playtest explore.";

server.tool(
  "forge_edit",
  `Apply ONE edit operation to the active game and persist it (read file -> apply -> atomic write; history is kept for forge_undo). ${EDIT_CONTRACT} Ops: createGame {id,title,goal} (replaces the whole doc!), createMap {mapId,width,height,fill}, paintRect {mapId,x1,y1,x2,y2,char}, paintCells {mapId,cells:[{x,y,char}]}, addTile {char,tile}, removeTile {char}, placeEntity {mapId,entity}, updateEntity {entityId,patch}, removeEntity {entityId}, setDialogue {entityId,interactions}, linkPortal {from:{mapId,x,y},to:{mapId,x,y},bidirectional?}, setEncounters {mapId,zone|null}, setPlayerStart {mapId,x,y,...}, addSpecies {species}, updateSpecies {speciesId,patch}, removeSpecies {speciesId}, addMove/updateMove/removeMove, addItem/updateItem/removeItem, setTypeChart {types,effectiveness}. The response includes an ASCII render of the touched map.`,
  {
    op: z.enum(OP_NAMES).describe("Operation name from the FORGE_OPS registry"),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The op's arguments object (see the op list in the tool description)"),
  },
  async ({ op, args }) => guard(() => runOps([{ op, args }])),
);

server.tool(
  "forge_batch",
  `Apply a SEQUENCE of edit operations to the active game in one call — same ops and semantics as forge_edit. Ops apply in order; on full success they are written as ONE atomic file update and ONE undo step. The batch is all-or-nothing: if any op is rejected, NOTHING is written and the response names the failed index and its errors — fix it and resend. ${EDIT_CONTRACT} Ideal for building a map in one shot: createMap, paintRect borders, placeEntity, linkPortal...`,
  {
    ops: z
      .array(
        z.object({
          op: z.enum(OP_NAMES),
          args: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1)
      .describe("Operations in application order"),
  },
  async ({ ops }) => guard(() => runOps(ops)),
);

function runOps(ops: ForgeOpCall[]): string {
  const a = requireActive();
  const before = readDoc(join(a.dir, GAME_FILE));
  const { result, wrote } = applyToFile(a.dir, ops);
  const touched = ops.map((call) => touchedMap(wrote ? result.doc : before, call));
  const lines: string[] = [];
  if (result.ok) {
    lines.push(
      ops.length === 1
        ? `applied ${ops[0].op} — written to ${GAME_FILE} (forge_undo reverts it)`
        : `applied all ${ops.length} ops — written to ${GAME_FILE} as one undo step`,
    );
  } else {
    lines.push(
      ops.length === 1
        ? `REJECTED ${ops[0].op} — nothing was written`
        : `ops[${result.failedIndex}] was REJECTED — the batch is all-or-nothing, so NOTHING was written; fix that op and resend the batch`,
    );
    lines.push(...result.opErrors.map((e) => `  - ${e}`));
  }
  lines.push(advisoryBlock(result.validation));
  const renders = mapRenders(result.doc, touched);
  if (renders) lines.push("", renders);
  return lines.join("\n");
}

server.tool(
  "forge_undo",
  "Revert the active game's game.json to its state before the last accepted forge_edit/forge_batch write (byte-for-byte restore from the per-game history; up to 50 steps deep). Use when an accepted edit turns out wrong — rejected ops never need undoing, they write nothing.",
  {},
  async () =>
    guard(() => {
      const a = requireActive();
      const undone = undoLast(a.dir);
      if (!undone.restored) return undone.message;
      const v = validateGame(readDoc(join(a.dir, GAME_FILE)));
      return [undone.message, advisoryBlock(v)].join("\n");
    }),
);

// ---------------------------------------------------------------------------
// Inspection tools
// ---------------------------------------------------------------------------

server.tool(
  "forge_map",
  "Render one map of the active game as ASCII: the tile grid with entity glyphs, portals (⇄), and the player start (@) overlaid, followed by a key listing every entity, portal (with dangling-destination markers), and the encounter table. Cheap — call it whenever you need to see what you're editing.",
  { mapId: z.string().describe("A map id (see forge_overview for the list)") },
  async ({ mapId }) => guard(() => renderMapAscii(activeDoc(), mapId)),
);

server.tool(
  "forge_overview",
  "Bird's-eye view of the active game: meta, catalog counts (types/moves/species/items), one line per map (size, entities, portals, encounter zone), and the current validation status. The map to start any editing session from.",
  {},
  async () =>
    guard(() => {
      const a = requireActive();
      const doc = activeDoc();
      const lines: string[] = [];
      const meta = isRecord(doc) && isRecord(doc.meta) ? doc.meta : {};
      lines.push(
        `${a.dirName}: "${String(meta.title ?? "?")}" (id: ${String(meta.id ?? "?")}, v${String(meta.version ?? "?")})`,
      );
      lines.push(`goal: ${String(meta.goal ?? "(none)")}`);
      const cat = isRecord(doc) && isRecord(doc.catalog) ? doc.catalog : {};
      const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      const types = isRecord(cat.typeChart) && Array.isArray(cat.typeChart.types)
        ? cat.typeChart.types.length
        : 0;
      lines.push(
        `catalog: ${types} types, ${count(cat.moves)} moves, ${count(cat.species)} species, ${count(cat.items)} items`,
      );
      const legend = isRecord(doc) && isRecord(doc.legend) ? Object.keys(doc.legend) : [];
      lines.push(`legend: ${legend.join(" ") || "(empty)"}`);
      const maps = isRecord(doc) && isRecord(doc.maps) ? doc.maps : {};
      const mapIds = Object.keys(maps);
      lines.push(`maps (${mapIds.length}):`);
      for (const [id, defU] of Object.entries(maps)) {
        if (!isRecord(defU)) continue;
        const rows = Array.isArray(defU.rows) ? defU.rows : [];
        const w = rows.length > 0 && typeof rows[0] === "string" ? [...rows[0]].length : 0;
        const enc = isRecord(defU.encounters)
          ? `encounters rate ${String(defU.encounters.rate)} (${count(defU.encounters.table)} species)`
          : "no encounters";
        lines.push(
          `  ${id}: ${w}x${rows.length}, ${count(defU.entities)} entities, ${count(defU.portals)} portals, ${enc}`,
        );
      }
      const player = isRecord(doc) && isRecord(doc.player) ? doc.player : {};
      lines.push(
        `player start: ${String(player.map ?? "?")} (${String(player.x ?? "?")}, ${String(player.y ?? "?")}), party ${count(player.party)}, money ${String(player.money ?? 0)}`,
      );
      lines.push(`undo steps available: ${historyCount(a.dir)}`);
      lines.push(advisoryBlock(validateGame(doc)));
      return lines.join("\n");
    }),
);

server.tool(
  "forge_validate",
  "Full, UNTRIMMED validateGame output for the active game: every error (each names the fix) and every warning. Edit responses show only the top 15 advisory items — use this when you're chasing the complete list toward a fully valid game.",
  {},
  async () =>
    guard(() => {
      const v = validateGame(activeDoc());
      if (v.ok && v.warnings.length === 0) return "OK — the game is fully valid";
      const lines = [
        v.ok ? "OK with warnings" : `INVALID — ${v.errors.length} error(s)`,
        ...v.errors.map((e) => `error: ${e}`),
        ...v.warnings.map((w) => `warning: ${w}`),
      ];
      return lines.join("\n");
    }),
);

server.tool(
  "forge_check",
  "Fast static critic (milliseconds — run after EVERY map/portal/blocking-entity edit): BFS reachability from the player start in two passes — optimistic (flag-gated blockers treated as open; anything unreachable here is a hard bug) and pessimistic (flags never earned; the delta shows what sits behind flag gates). Reports unreachable maps/entities, orphan portals, and encounter zones that can never fire. Requires the game to validate — fix forge_validate errors first.",
  {},
  async () =>
    guard(() => {
      const report = analyzeReachability(activeGame());
      return JSON.stringify(report, null, 2);
    }),
);

server.tool(
  "forge_playtest",
  'Play the active game automatically and return the JSON report. Modes: "explore" — deterministic coverage explorer that pathfinds to every reachable map/entity and fights greedily; the go/no-go check before calling content done (win expected on a finished game; the report shows maps NOT reached, flags set, battles, and exactly where it stopped). "script" — replay an exact action list (whitespace/comma-separated words: north south east west interact move1..4 switch1..6 item1..9 catch run; # comments) to pin a golden path; rejections are recorded, not fatal. "reach" — same static analysis as forge_check. Deterministic: same seed, same result. Requires the game to validate.',
  {
    mode: z.enum(["explore", "script", "reach"]),
    actions: z
      .string()
      .optional()
      .describe("script mode only: the action words to replay"),
    maxSteps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("explore mode step budget (default 1500)"),
    seed: z.number().int().optional().describe("Sim seed (default 1)"),
  },
  async ({ mode, actions, maxSteps, seed }) =>
    guard(() => {
      const game = activeGame();
      if (mode === "reach") {
        return JSON.stringify(analyzeReachability(game), null, 2);
      }
      if (mode === "script") {
        if (!actions) {
          throw new Error(
            'script mode needs actions — e.g. { mode: "script", actions: "east east north interact" }',
          );
        }
        return JSON.stringify(runScript(game, actions, { seed }), null, 2);
      }
      return JSON.stringify(runExplore(game, { maxSteps: maxSteps ?? 1500, seed }), null, 2);
    }),
);

await server.connect(new StdioServerTransport());
