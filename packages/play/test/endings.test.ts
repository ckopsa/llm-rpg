import { describe, expect, it } from "vitest";
import { validateGame, type Game } from "@llm-rpg/engine";
import { rejectionIn, runExplore, runScript } from "../src/run.js";

/**
 * djt.4 (play side) — playtest reports carry the ending: `ending` on both
 * script and explore reports, stopReason "ended" for non-victory endings,
 * `win` unchanged in meaning, and post-ending actions counted as rejections.
 */

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

/** Keeper to the east: interact ends the game with the given ending id. */
function fixture(id: string): Game {
  return load({
    meta: { id: "ending-play", title: "Ending Play", goal: "end it" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          {
            id: "keeper", name: "Keeper", glyph: "K", x: 2, y: 1,
            interactions: [
              { commands: [{ type: "end", id, text: "It is finished." }] },
            ],
          },
        ],
      },
    },
    player: { glyph: "@", map: "main", x: 1, y: 1 },
  });
}

describe("script reports", () => {
  it("a non-victory ending: stopReason 'ended', ending set, win false", () => {
    const report = runScript(fixture("exile"), "interact interact interact");
    expect(report.win).toBe(false);
    expect(report.ending).toEqual({ id: "exile", text: "It is finished." });
    expect(report.stopReason).toBe("ended");
    expect(report.stopDetail).toBe('reached ending "exile"');
    // The run stopped at the ending: the extra interacts were never issued.
    expect(report.steps).toBe(1);
  });

  it("a victory ending keeps win semantics", () => {
    const report = runScript(fixture("victory"), "interact");
    expect(report.win).toBe(true);
    expect(report.stopReason).toBe("won");
    expect(report.ending).toEqual({ id: "victory", text: "It is finished." });
  });

  it("post-ending refusals count as rejections", () => {
    expect(rejectionIn(["The game has ended. Reset to play again."])).toBe(
      "The game has ended. Reset to play again.",
    );
  });
});

describe("explore reports", () => {
  it("the explorer stops at a non-victory ending and reports it", () => {
    const report = runExplore(fixture("exile"), { maxSteps: 50 });
    expect(report.win).toBe(false);
    expect(report.ending).toEqual({ id: "exile", text: "It is finished." });
    expect(report.stopReason).toBe("ended");
  });

  it("a victory ending still reports as won", () => {
    const report = runExplore(fixture("victory"), { maxSteps: 50 });
    expect(report.win).toBe(true);
    expect(report.stopReason).toBe("won");
    expect(report.ending!.id).toBe("victory");
  });
});
