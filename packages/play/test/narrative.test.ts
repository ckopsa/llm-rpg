import { describe, expect, it } from "vitest";
import { validateGame, type Game } from "@llm-rpg/engine";
import { runExplore, runScript } from "../src/run.js";
import { analyzeReachability } from "../src/reachability.js";

/**
 * djt.6 (engine half, play side) — the playtest harness on a catalog-free
 * narrative game: the explorer's battle policy never engages, reachability
 * is unaffected, and `--goal explore` style runs finish clean.
 */

function narrativeFixture(): unknown {
  return {
    meta: { id: "quiet-road", title: "The Quiet Road", goal: "reach the shrine and pray" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      road: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          {
            id: "pilgrim", name: "Pilgrim", glyph: "P", x: 1, y: 1, blocking: false,
            interactions: [
              {
                forbidsFlag: "blessed",
                commands: [
                  { type: "say", text: "The shrine is east." },
                  { type: "set_flag", flag: "blessed" },
                ],
              },
              { commands: [{ type: "say", text: "Go on, now." }] },
            ],
          },
        ],
        portals: [{ x: 3, y: 1, toMap: "shrine", toX: 1, toY: 1 }],
      },
      shrine: {
        rows: ["####", "#..#", "####"],
        entities: [
          {
            id: "altar", name: "Altar", glyph: "A", x: 2, y: 1,
            interactions: [
              {
                when: { flag: "blessed" },
                commands: [
                  { type: "passage", lines: ["The quiet here is full, not empty."] },
                  { type: "win", text: "You kneel, and the road is complete." },
                ],
              },
              { commands: [{ type: "say", text: "The altar waits." }] },
            ],
          },
        ],
      },
    },
    player: { glyph: "@", map: "road", x: 2, y: 1, money: 0 },
  };
}

function load(): Game {
  const result = validateGame(narrativeFixture());
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  return result.game!;
}

describe("catalog-free playtest harness", () => {
  it("the explorer runs clean and wins without ever engaging battles", () => {
    const report = runExplore(load(), { maxSteps: 100, seed: 1 });
    expect(report.win).toBe(true);
    expect(report.stopReason).toBe("won");
    expect(report.battles).toEqual({ fought: 0, won: 0, lost: 0, fled: 0 });
    expect(report.inBattle).toBe(false);
    expect(report.party).toEqual([]);
    expect(report.mapsVisited.sort()).toEqual(["road", "shrine"]);
    expect(report.entitiesInteracted.sort()).toEqual(["altar", "pilgrim"]);
    // The passage arrives in the transcripted events, in full.
    expect(report.lastEvents.some((e) => e.includes("The quiet here is full, not empty."))).toBe(true);
  });

  it("runScript replays a winning narrative script", () => {
    const report = runScript(load(), "interact east interact", { seed: 1 });
    expect(report.win).toBe(true);
    expect(report.rejections).toEqual([]);
    expect(report.finalObservation).toContain("Status: WON");
  });

  it("reachability analysis is unaffected by the missing catalog", () => {
    const report = analyzeReachability(load());
    expect(report.verdict).toBe("pass");
    expect(report.unreachableMaps).toEqual([]);
    expect(report.wildZoneIssues).toEqual([]);
  });
});
