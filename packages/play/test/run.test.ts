import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGame, type Game } from "@llm-rpg/engine";
import { runExplore, runScript } from "../src/run.js";
import type { TranscriptEntry } from "../src/autoplay.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function loadGame(rel: string): Game {
  const result = validateGame(JSON.parse(readFileSync(join(ROOT, rel), "utf8")));
  expect(result.errors).toEqual([]);
  return result.game!;
}

/** The demo's winning script: the deterministic explorer wins the demo (a
 *  fact pinned by packages/engine/test/emberwood.test.ts), so its transcript
 *  IS a verified winning action list. */
function demoWinningScript(game: Game): string[] {
  const words: string[] = [];
  const report = runExplore(game, {
    maxSteps: 400,
    seed: 1,
    onStep: (e) => words.push(e.action),
  });
  expect(report.win).toBe(true);
  return words;
}

describe("runScript", () => {
  const game = loadGame("games/demo/game.json");

  it("returns win:true for the demo winning script, as a plain serializable object", () => {
    const report = runScript(game, demoWinningScript(game), { seed: 1 });
    expect(report.mode).toBe("script");
    expect(report.win).toBe(true);
    expect(report.stopReason).toBe("won");
    expect(report.mapsVisited).toEqual(["village", "east-road"]);
    expect(report.flags).toContain("elder_blessing");
    expect(report.entitiesInteracted).toContain("elder");
    expect(report.steps).toBeLessThanOrEqual(report.totalActions);
    expect(report.finalObservation).toContain("*** YOU WIN ***");
    // Plain data: JSON round-trips to a deep-equal object (no class
    // instances, functions, Maps, or Sets anywhere in the report).
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(Object.getPrototypeOf(report)).toBe(Object.prototype);
  });

  it("records rejections without stopping by default, and stops with strict", () => {
    // First move walks into the elder's hut wall region: pick a definitely
    // blocked move from the start (village (2,6), west into x=1 ... use a
    // guaranteed rejection: interact with nothing adjacent).
    const relaxed = runScript(game, ["interact", "east"], { seed: 1 });
    expect(relaxed.win).toBe(false);
    expect(relaxed.stopReason).toBe("script-exhausted");
    expect(relaxed.steps).toBe(2);
    expect(relaxed.rejections).toHaveLength(1);
    expect(relaxed.rejections[0]).toMatchObject({ step: 1, action: "interact" });

    const strict = runScript(game, ["interact", "east"], { seed: 1, strict: true });
    expect(strict.stopReason).toBe("stopped");
    expect(strict.steps).toBe(1);
  });

  it("stops on an unknown action word", () => {
    const report = runScript(game, "north flarble south");
    expect(report.stopReason).toBe("stopped");
    expect(report.stopDetail).toContain('unknown action "flarble"');
    expect(report.steps).toBe(1);
  });

  it("accepts raw script source with comments", () => {
    const report = runScript(game, "north # a comment\n south,east");
    expect(report.steps).toBe(3);
    expect(report.totalActions).toBe(3);
  });
});

describe("runExplore", () => {
  it("wins the demo and reports coverage as plain data", () => {
    const game = loadGame("games/demo/game.json");
    const transcript: TranscriptEntry[] = [];
    const report = runExplore(game, {
      maxSteps: 400,
      seed: 1,
      onStep: (e) => transcript.push(e),
    });
    expect(report.mode).toBe("explore");
    expect(report.win).toBe(true);
    expect(report.stopReason).toBe("won");
    expect(report.mapsUnvisited).toEqual([]);
    expect(report.steps).toBe(transcript.length);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("battle details and the event tail (85g.13)", () => {
  const game = loadGame("games/demo/game.json");
  // The README's pinned winning replay for the demo — wild battle included.
  const words =
    "east east east east east east north north north north interact " +
    "south south south south east east east east east east east " +
    "move1 move1 move1 west west west west west interact";

  it("script reports carry a per-battle battleDetails list", () => {
    const report = runScript(game, words, { seed: 1 });
    expect(report.battleDetails.length).toBe(report.battles.fought);
    expect(report.battleDetails.length).toBeGreaterThan(0);
    const b = report.battleDetails[0];
    expect(b.kind).toBe("wild");
    expect(b.opponent).toMatch(/^wild /);
    expect(b.enemyParty.length).toBeGreaterThan(0);
    expect(b.enemyParty[0]).toHaveProperty("speciesId");
    expect(b.enemyParty[0]).toHaveProperty("level");
    expect(["won", "lost", "fled", "captured"]).toContain(b.result);
    expect(b.actions).toBeGreaterThan(0);
    expect(b.endStep).toBeGreaterThanOrEqual(b.startStep);
    // The party's post-battle state is captured for diagnosis.
    expect(b.partyAfter.length).toBeGreaterThan(0);
    expect(b.partyAfter[0]).toHaveProperty("hp");
    expect(b.partyAfter[0]).toHaveProperty("maxHp");
    expect(b.partyAfter[0]).toHaveProperty("level");
    // Consistency with the summary stats.
    const won = report.battleDetails.filter((d) => d.result === "won").length;
    expect(won).toBe(report.battles.won);
  });

  it("explore reports carry the same battleDetails shape", () => {
    // The emberwood explorer fights for real (pinned winnable in CI configs
    // that run it); here just pin the shape contract on the demo run.
    const report = runExplore(game, { maxSteps: 400, seed: 1 });
    expect(report.battleDetails.length).toBe(report.battles.fought);
    for (const b of report.battleDetails) {
      expect(b.map).toBeTruthy();
      expect(b.result).not.toBe("ongoing"); // the demo run resolves its battles
    }
  });

  it("tail controls how many trailing events lastEvents keeps (default 20)", () => {
    const dflt = runScript(game, words, { seed: 1 });
    expect(dflt.lastEvents.length).toBeLessThanOrEqual(20);
    const five = runScript(game, words, { seed: 1, tail: 5 });
    expect(five.lastEvents.length).toBe(5);
    expect(dflt.lastEvents.slice(-5)).toEqual(five.lastEvents);
    const wide = runExplore(game, { maxSteps: 400, seed: 1, tail: 100 });
    expect(wide.lastEvents.length).toBeGreaterThan(20);
    expect(wide.lastEvents.length).toBeLessThanOrEqual(100);
  });

  it("completed mirrors win for a victory (and stays false without one)", () => {
    const won = runScript(game, words, { seed: 1 });
    expect(won.completed).toBe(true);
    const not = runScript(game, ["east"], { seed: 1 });
    expect(not.completed).toBe(false);
  });
});
