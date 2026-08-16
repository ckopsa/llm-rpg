import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGame, type Game } from "@llm-rpg/engine";
import { analyzeReachability } from "../src/reachability.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function loadGame(rel: string): Game {
  const result = validateGame(JSON.parse(readFileSync(join(ROOT, rel), "utf8")));
  expect(result.errors).toEqual([]);
  return result.game!;
}

describe("analyzeReachability on Emberwood", () => {
  const game = loadGame("games/emberwood/game.json");
  const report = analyzeReachability(game);
  const byId = Object.fromEntries(report.maps.map((m) => [m.id, m]));

  it("finds all 7 maps optimistically reachable", () => {
    expect(report.maps).toHaveLength(7);
    expect(report.maps.every((m) => m.optimistic)).toBe(true);
    expect(report.unreachableMaps).toEqual([]);
  });

  it("pessimistic pass shows the flag gates: cinder-ascent and ashen-peak close", () => {
    // Verified against the content: warden-hollis (passableWithFlag
    // starter_chosen) guards Kilnhearth's only exit, so with gates shut the
    // whole world beyond the starter town closes — including the badge-gated
    // ascent (gatewarden-lise needs badge_fern on the way to cinder-ascent).
    expect(byId["cinder-ascent"].optimistic).toBe(true);
    expect(byId["cinder-ascent"].pessimistic).toBe(false);
    expect(byId["ashen-peak"].optimistic).toBe(true);
    expect(byId["ashen-peak"].pessimistic).toBe(false);
    expect(byId["kilnhearth"].pessimistic).toBe(true);
    expect(byId["kiln-interior"].pessimistic).toBe(true);
    expect(report.flagGatedMaps.sort()).toEqual(
      ["ashen-peak", "cinder-ascent", "mistmarsh", "mosshollow", "verdant-trail"].sort(),
    );
  });

  it("has no orphan portals or dead wild zones", () => {
    expect(report.orphanPortals).toEqual([]);
    expect(report.wildZoneIssues).toEqual([]);
  });

  it("pins the one un-interactable entity: the Great Hearth behind Vespera", () => {
    // Real content quirk: vespera (blocking trainer, no passableWithFlag)
    // stands on the only walkable tile adjacent to great-hearth, so the
    // hearth's interactions are dead content — the win fires from vespera's
    // rewardCommands instead. If the game is fixed (e.g. vespera gets
    // passableWithFlag), update this to expect [] and verdict "pass".
    expect(report.unreachableEntities.map((e) => e.id)).toEqual(["great-hearth"]);
    expect(report.verdict).toBe("fail");
  });

  it("runs in milliseconds", () => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) analyzeReachability(game);
    const perRun = (performance.now() - start) / 10;
    expect(perRun).toBeLessThan(50);
  });
});

describe("analyzeReachability on the demo", () => {
  it("passes clean: every map and entity reachable in both passes", () => {
    const report = analyzeReachability(loadGame("games/demo/game.json"));
    expect(report.verdict).toBe("pass");
    expect(report.maps.every((m) => m.optimistic && m.pessimistic)).toBe(true);
    expect(report.unreachableEntities).toEqual([]);
    expect(report.flagGatedMaps).toEqual([]);
    expect(report.orphanPortals).toEqual([]);
    expect(report.wildZoneIssues).toEqual([]);
  });
});

describe("analyzeReachability catches broken fixtures", () => {
  function brokenDemo(): Game {
    const game = loadGame("games/demo/game.json");
    // Sever the village -> east-road portal by pointing it back at the
    // village: east-road becomes an unreachable map, and its return portal
    // (east-road.portals[0]) becomes an orphan whose destination tile the
    // player can never reach through it.
    const broken = structuredClone(game);
    broken.maps["village"].portals[0] = {
      x: 11,
      y: 6,
      toMap: "village",
      toX: 2,
      toY: 6,
    };
    return broken;
  }

  it("flags the unreachable map, its entities, and the orphan portal", () => {
    const report = analyzeReachability(brokenDemo());
    expect(report.verdict).toBe("fail");
    expect(report.unreachableMaps).toEqual(["east-road"]);
    const byId = Object.fromEntries(report.maps.map((m) => [m.id, m]));
    expect(byId["east-road"].optimistic).toBe(false);
    expect(byId["east-road"].pessimistic).toBe(false);
    expect(byId["village"].optimistic).toBe(true);
    // Every east-road entity is now unreachable.
    for (const e of report.unreachableEntities) expect(e.map).toBe("east-road");
    expect(report.unreachableEntities.length).toBeGreaterThan(0);
    // The stranded return portal on east-road is an orphan.
    expect(report.orphanPortals).toHaveLength(1);
    expect(report.orphanPortals[0]).toMatchObject({ map: "east-road", index: 0 });
    // east-road's encounter zone can never fire.
    expect(report.wildZoneIssues.map((w) => w.map)).toContain("east-road");
  });

  it("flags a portal whose destination map does not exist", () => {
    const game = loadGame("games/demo/game.json");
    const broken = structuredClone(game);
    broken.maps["village"].portals[0].toMap = "nowhere";
    const report = analyzeReachability(broken);
    expect(report.verdict).toBe("fail");
    expect(
      report.orphanPortals.some(
        (p) => p.map === "village" && p.reason.includes('"nowhere"'),
      ),
    ).toBe(true);
  });
});
