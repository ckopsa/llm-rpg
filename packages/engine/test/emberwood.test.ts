import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sim, parseAction, validateGame, type Game } from "../src/index.js";
import { runExplorer } from "../../play/src/autoplay.js";

/**
 * Content regression gates. These pin the *games*, not the engine: an edit to
 * games/emberwood/game.json (or to the verified script in its README) that
 * breaks the known winning run fails here, loudly, with the divergence point.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function loadGame(rel: string): Game {
  const result = validateGame(
    JSON.parse(readFileSync(join(ROOT, rel), "utf8")),
  );
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
  return result.game!;
}

/** Replay the README's verified script and hand back the sim it produced. */
function runVerifiedScript(): Sim {
  // The script lives in the README's third code fence so that content edits
  // which invalidate the documented run fail this test rather than silently
  // shipping a README that lies.
  const readme = readFileSync(join(ROOT, "games/emberwood/README.md"), "utf8");
  const fences = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  expect(fences.length).toBeGreaterThanOrEqual(3);
  const words = fences[2].split(/[\s,]+/).filter(Boolean);
  expect(words.length).toBe(1251);

  const game = loadGame("games/emberwood/game.json");
  const sim = new Sim(game, 1); // the CLI's default seed
  for (const [i, word] of words.entries()) {
    const action = parseAction(word);
    expect(action, `script word ${i + 1} ("${word}") is not a valid action`).toBeDefined();
    sim.act(action!);
    if (sim.state.won) break;
  }
  return sim;
}

describe("emberwood beatability", () => {
  it("the README's verified script relights the Great Hearth at turn 1242", () => {
    const sim = runVerifiedScript();
    expect(sim.state.flags).toContain("vespera_stilled");
    expect(sim.state.flags).toContain("hearth_relit");
    expect(sim.state.turn).toBe(1242);
    // Vespera is no longer the end of the game — she is the door to the
    // Underhearth, so the same 1242 turns now finish an act, not the story.
    expect(sim.state.won).toBe(false);
    expect(sim.state.objective).toContain("slag");
  });

  it("relighting opens the descent, which Vespera was standing in front of", () => {
    const sim = runVerifiedScript();
    // Row 2 is the summit's only east-west corridor and she stands in it; her
    // defeat text says she steps aside, so she had better actually do it.
    for (let i = 0; i < 7; i++) sim.act(parseAction("east")!);
    expect(sim.state.map).toBe("hearth-mouth");
    expect(sim.state.objective).toContain("Underhearth");
  });
});

describe("demo explorability", () => {
  it("goal-mode explorer reaches both maps and earns elder_blessing within 400 steps", () => {
    const game = loadGame("games/demo/game.json");
    const { report } = runExplorer(game, { maxSteps: 400, seed: 1 });
    expect(report.mapsVisited).toContain("village");
    expect(report.mapsVisited).toContain("east-road");
    expect(report.flags).toContain("elder_blessing");
    expect(report.steps).toBeLessThanOrEqual(400);
    // The demo is winnable by pure exploration — keep it that way.
    expect(report.won).toBe(true);
  });
});
