import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateGame } from "@llm-rpg/engine";
import {
  GAME_FILE,
  HISTORY_CAP,
  HISTORY_DIR,
  applyToFile,
  historyCount,
  listGames,
  newGameFromTemplate,
  serializeDoc,
  undoLast,
} from "../src/forge-store.js";
import { analyzeReachability } from "../src/reachability.js";
import { runExplore } from "../src/run.js";

const PLAY_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEMPLATE_FILE = join(REPO_ROOT, "games/_templates/starter/game.json");

const noTmpFilesIn = (dir: string) =>
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);

describe("starter template", () => {
  const doc = JSON.parse(readFileSync(TEMPLATE_FILE, "utf8"));
  const v = validateGame(doc);

  it("is a fully valid game", () => {
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("passes reachability", () => {
    const report = analyzeReachability(v.game!);
    expect(report.verdict).toBe("pass");
    expect(report.unreachableMaps).toEqual([]);
    expect(report.orphanPortals).toEqual([]);
    expect(report.wildZoneIssues).toEqual([]);
  });

  it("is winnable by the explorer", () => {
    const report = runExplore(v.game!, { maxSteps: 1500 });
    expect(report.win).toBe(true);
    expect(report.mapsUnvisited).toEqual([]);
  });
});

describe("forge-store persistence layer", () => {
  let gamesDir: string;

  beforeAll(() => {
    gamesDir = mkdtempSync(join(tmpdir(), "forge-store-"));
  });
  afterAll(() => {
    rmSync(gamesDir, { recursive: true, force: true });
  });

  it("creates a new game from the starter template with patched meta", () => {
    const created = newGameFromTemplate(gamesDir, {
      dirName: "myquest",
      id: "my-quest",
      title: "My Quest",
      goal: "Do the thing.",
    });
    expect(existsSync(join(gamesDir, "myquest", GAME_FILE))).toBe(true);
    expect(existsSync(join(gamesDir, "myquest", "sprites.json"))).toBe(true);
    const doc = created.doc as { meta: Record<string, unknown> };
    expect(doc.meta).toEqual({
      id: "my-quest",
      title: "My Quest",
      version: "0.1.0",
      goal: "Do the thing.",
    });
    // The template is complete: the fresh copy validates as-is.
    expect(created.validation.errors).toEqual([]);
    noTmpFilesIn(join(gamesDir, "myquest"));
  });

  it("refuses to overwrite an existing game dir", () => {
    expect(() =>
      newGameFromTemplate(gamesDir, {
        dirName: "myquest",
        id: "x",
        title: "X",
        goal: "y",
      }),
    ).toThrow(/already exists/);
  });

  it("rejects dir names that would hide the game (leading underscore)", () => {
    expect(() =>
      newGameFromTemplate(gamesDir, { dirName: "_hidden", id: "x", title: "X", goal: "y" }),
    ).toThrow(/invalid/);
  });

  it('template "blank" creates a bare createGame draft', () => {
    const created = newGameFromTemplate(gamesDir, {
      dirName: "bare",
      id: "bare",
      title: "Bare",
      goal: "g",
      template: "blank",
    });
    const doc = created.doc as Record<string, unknown>;
    expect(doc.maps).toEqual({});
    expect(created.validation.ok).toBe(false); // drafts start invalid — that's fine
    expect(existsSync(join(gamesDir, "bare", "sprites.json"))).toBe(true);
  });

  it("listGames sees created games but never _templates", () => {
    const names = listGames(join(REPO_ROOT, "games")).map((g) => g.dirName);
    expect(names).toContain("demo");
    expect(names.some((n) => n.startsWith("_"))).toBe(false);
    const local = listGames(gamesDir).map((g) => g.dirName);
    expect(local).toEqual(["bare", "myquest"]);
  });

  it("an accepted batch is applied and the file on disk matches, atomically", () => {
    const gameDir = join(gamesDir, "myquest");
    const { result, wrote } = applyToFile(gameDir, [
      {
        op: "paintCells",
        args: {
          mapId: "hearthside-town",
          cells: [
            { x: 3, y: 1, char: "," },
            { x: 3, y: 2, char: "," },
            { x: 3, y: 3, char: "," },
          ],
        },
      },
      { op: "addTile", args: { char: "o", tile: { name: "boulder", glyph: "🪨", walkable: false, wild: false } } },
    ]);
    expect(result.ok).toBe(true);
    expect(wrote).toBe(true);
    const onDisk = readFileSync(join(gameDir, GAME_FILE), "utf8");
    expect(onDisk).toBe(serializeDoc(result.doc));
    expect(historyCount(gameDir)).toBe(1);
    noTmpFilesIn(gameDir);
  });

  it("a rejected op writes nothing — no file change, no history entry", () => {
    const gameDir = join(gamesDir, "myquest");
    const before = readFileSync(join(gameDir, GAME_FILE), "utf8");
    const historyBefore = historyCount(gameDir);
    const { result, wrote } = applyToFile(gameDir, [
      { op: "paintRect", args: { mapId: "no-such-map", x1: 0, y1: 0, x2: 1, y2: 1, char: "." } },
    ]);
    expect(result.ok).toBe(false);
    expect(wrote).toBe(false);
    expect(result.opErrors[0]).toMatch(/unknown map "no-such-map"/);
    expect(readFileSync(join(gameDir, GAME_FILE), "utf8")).toBe(before);
    expect(historyCount(gameDir)).toBe(historyBefore);
  });

  it("a batch is all-or-nothing: a mid-batch rejection writes nothing", () => {
    const gameDir = join(gamesDir, "myquest");
    const before = readFileSync(join(gameDir, GAME_FILE), "utf8");
    const { result, wrote } = applyToFile(gameDir, [
      { op: "paintCells", args: { mapId: "hearthside-town", cells: [{ x: 4, y: 1, char: "," }] } },
      { op: "paintRect", args: { mapId: "hearthside-town", x1: 0, y1: 0, x2: 99, y2: 99, char: "." } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failedIndex).toBe(1);
    expect(wrote).toBe(false);
    expect(readFileSync(join(gameDir, GAME_FILE), "utf8")).toBe(before);
  });

  it("undo restores the previous file byte-for-byte and pops the entry", () => {
    const gameDir = join(gamesDir, "myquest");
    const before = readFileSync(join(gameDir, GAME_FILE), "utf8");
    applyToFile(gameDir, [
      { op: "paintCells", args: { mapId: "hearthside-town", cells: [{ x: 5, y: 3, char: "," }] } },
    ]);
    expect(readFileSync(join(gameDir, GAME_FILE), "utf8")).not.toBe(before);
    const undone = undoLast(gameDir);
    expect(undone.restored).toBe(true);
    expect(readFileSync(join(gameDir, GAME_FILE), "utf8")).toBe(before);
    expect(historyCount(gameDir)).toBe(1); // back to the entry from the batch test
    noTmpFilesIn(gameDir);
  });

  it("undo with no history says so instead of failing", () => {
    const gameDir = join(gamesDir, "bare");
    const undone = undoLast(gameDir);
    expect(undone.restored).toBe(false);
    expect(undone.message).toMatch(/nothing to undo/);
  });

  it(`history is capped at ${HISTORY_CAP} entries`, () => {
    const gameDir = join(gamesDir, "bare");
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      const { result } = applyToFile(gameDir, [
        { op: "createMap", args: { mapId: `m${i}`, width: 2, height: 2, fill: "." } },
      ]);
      expect(result.ok).toBe(true);
    }
    expect(historyCount(gameDir)).toBe(HISTORY_CAP);
    // The newest entries survive: undoing once removes map m54.
    const undone = undoLast(gameDir);
    expect(undone.restored).toBe(true);
    const doc = JSON.parse(readFileSync(join(gameDir, GAME_FILE), "utf8"));
    expect(Object.keys(doc.maps)).not.toContain(`m${HISTORY_CAP + 4}`);
    expect(Object.keys(doc.maps)).toContain(`m${HISTORY_CAP + 3}`);
  });
});

describe("forge MCP server end-to-end (real stdio transport)", () => {
  let gamesDir: string;
  let client: Client;

  const textOf = (r: unknown): string =>
    ((r as { content: { type: string; text: string }[] }).content[0] ?? { text: "" }).text;

  beforeAll(async () => {
    gamesDir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    client = new Client({ name: "forge-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(PLAY_DIR, "src/forge-mcp.ts"), gamesDir],
      cwd: PLAY_DIR,
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(gamesDir, { recursive: true, force: true });
  });

  it("boots and lists the full tool set", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        "forge_list_games",
        "forge_new_game",
        "forge_open",
        "forge_edit",
        "forge_batch",
        "forge_undo",
        "forge_map",
        "forge_overview",
        "forge_validate",
        "forge_check",
        "forge_playtest",
      ].sort(),
    );
  });

  it("runs the whole authoring loop: new game -> paint -> check -> playtest -> undo", async () => {
    // 1. New game from the starter template.
    const created = await client.callTool({
      name: "forge_new_game",
      arguments: { dirName: "e2e", id: "e2e-game", title: "E2E Game", goal: "Win the template quest." },
    });
    expect(textOf(created)).toContain("active game");
    expect(textOf(created)).toContain("validation: OK");
    const gameFile = join(gamesDir, "e2e", GAME_FILE);
    expect(existsSync(gameFile)).toBe(true);
    const beforePaint = readFileSync(gameFile, "utf8");

    // 2. Paint a 3-tile change.
    const painted = await client.callTool({
      name: "forge_edit",
      arguments: {
        op: "paintCells",
        args: {
          mapId: "hearthside-town",
          cells: [
            { x: 3, y: 1, char: "," },
            { x: 3, y: 2, char: "," },
            { x: 3, y: 3, char: "," },
          ],
        },
      },
    });
    expect(textOf(painted)).toContain("applied paintCells");
    expect(textOf(painted)).toContain("hearthside-town — 8x5"); // ASCII render of the touched map
    expect(readFileSync(gameFile, "utf8")).not.toBe(beforePaint);

    // 3. Reachability check passes.
    const check = await client.callTool({ name: "forge_check", arguments: {} });
    expect(JSON.parse(textOf(check)).verdict).toBe("pass");

    // 4. Explore playtest wins the template quest.
    const played = await client.callTool({
      name: "forge_playtest",
      arguments: { mode: "explore" },
    });
    const report = JSON.parse(textOf(played));
    expect(report.win).toBe(true);
    expect(report.flags).toContain("trail_brazier_lit");

    // 5. A rejected edit changes nothing on disk.
    const afterPaint = readFileSync(gameFile, "utf8");
    const rejected = await client.callTool({
      name: "forge_edit",
      arguments: { op: "paintRect", args: { mapId: "hearthside-town", x1: 0, y1: 0, x2: 50, y2: 50, char: "." } },
    });
    expect(textOf(rejected)).toContain("REJECTED");
    expect(readFileSync(gameFile, "utf8")).toBe(afterPaint);

    // 6. Undo restores the pre-paint file byte-for-byte.
    const undone = await client.callTool({ name: "forge_undo", arguments: {} });
    expect(textOf(undone)).toContain("restored");
    expect(readFileSync(gameFile, "utf8")).toBe(beforePaint);
    noTmpFilesIn(join(gamesDir, "e2e"));
    expect(existsSync(join(gamesDir, "e2e", HISTORY_DIR))).toBe(true);
  }, 60_000);

  it("errors are returned as tool errors, not crashes", async () => {
    const bad = await client.callTool({ name: "forge_map", arguments: { mapId: "nope" } });
    expect(textOf(bad)).toContain('unknown map "nope"');
    const stillAlive = await client.callTool({ name: "forge_overview", arguments: {} });
    expect(textOf(stillAlive)).toContain("e2e");
  });
});
