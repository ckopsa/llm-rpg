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

describe("explorer narrative upgrades (djt.8 / 85g.14)", () => {
  it("targets unfired step-trigger tiles and reaches a trigger-driven ending", () => {
    // The ending sits on a step trigger at a dead-end tile no entity or map
    // edge would ever route the explorer to.
    const result = validateGame({
      meta: { id: "trigger-walk", title: "Trigger Walk", goal: "stand on the mark" },
      legend: {
        "#": { name: "wall", glyph: "#", walkable: false },
        ".": { name: "floor", glyph: ".", walkable: true },
      },
      maps: {
        yard: {
          rows: ["######", "#....#", "#....#", "######"],
          entities: [],
          triggers: [
            {
              id: "the-mark",
              on: "step",
              tiles: [{ x: 4, y: 2 }],
              commands: [
                { type: "passage", lines: ["The ground remembers you."] },
                { type: "end", id: "remembered", text: "The yard falls silent." },
              ],
            },
          ],
        },
      },
      player: { glyph: "@", map: "yard", x: 1, y: 1 },
    });
    expect(result.errors).toEqual([]);
    const report = runExplore(result.game!, { maxSteps: 50, seed: 1 });
    expect(report.stopReason).toBe("ended");
    expect(report.ending).toEqual({ id: "remembered", text: "The yard falls silent." });
    expect(report.completed).toBe(true);
    expect(report.win).toBe(false); // win stays win
    expect(report.lastEvents.some((e) => e.includes("The ground remembers you."))).toBe(true);
  });

  it("an exhausted stop names the closed gate and its missing flag", () => {
    const result = validateGame({
      meta: { id: "gated", title: "Gated", goal: "get past the door" },
      legend: {
        "#": { name: "wall", glyph: "#", walkable: false },
        ".": { name: "floor", glyph: ".", walkable: true },
      },
      maps: {
        hall: {
          // Corridor with a gatekeeper wall: everything east of x=3 is closed.
          rows: ["#######", "#.....#", "#######"],
          entities: [
            {
              id: "doorwarden", name: "Doorwarden", glyph: "D", x: 3, y: 1,
              blocking: true, passableWithFlag: "writ_of_passage",
              interactions: [{ commands: [{ type: "say", text: "No writ, no passage." }] }],
            },
            {
              id: "scribe", name: "Scribe", glyph: "S", x: 5, y: 1,
              interactions: [{ commands: [{ type: "win", text: "The writ is signed." }] }],
            },
          ],
        },
      },
      player: { glyph: "@", map: "hall", x: 1, y: 1 },
    });
    expect(result.errors).toEqual([]); // (the unwritten flag is a warning, not an error)
    const report = runExplore(result.game!, { maxSteps: 100, seed: 1 });
    expect(report.win).toBe(false);
    expect(report.stopReason).toBe("exhausted");
    expect(report.stopDetail).toContain('gate "doorwarden" on hall still blocks');
    expect(report.stopDetail).toContain('needs flag "writ_of_passage"');
  });
});
