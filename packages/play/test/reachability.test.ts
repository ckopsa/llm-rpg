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

  it("finds all 10 maps optimistically reachable", () => {
    expect(report.maps).toHaveLength(10);
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
    // The Underhearth hangs off the summit behind `hearth_relit`, so the three
    // postgame maps are flag-gated too — that is the point of them.
    expect(report.flagGatedMaps.sort()).toEqual(
      [
        "ashen-peak", "cinder-ascent", "mistmarsh", "mosshollow", "verdant-trail",
        "hearth-mouth", "ember-veins", "first-hearth",
      ].sort(),
    );
  });

  it("has no orphan portals or dead wild zones", () => {
    expect(report.orphanPortals).toEqual([]);
    expect(report.wildZoneIssues).toEqual([]);
  });

  it("has no un-interactable entities — the Great Hearth opened up", () => {
    // This used to pin great-hearth as dead content: vespera blocked the only
    // walkable tile beside it and never stepped aside. She now carries
    // passableWithFlag "vespera_stilled" so the Underhearth behind her is
    // reachable, which incidentally freed the hearth too. The previous version
    // of this test predicted the fix and asked for exactly this update.
    expect(report.unreachableEntities).toEqual([]);
    expect(report.verdict).toBe("pass");
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

describe("teleport edges and stated limitations (llm-rpg-ran)", () => {
  /** Two islands with NO portal between them: the only way across is a
   *  teleport_player in the ferryman's dialogue (optionally when-gated),
   *  plus a court map reachable only through an enter trigger's teleport. */
  function teleportFixture(opts: { gateCrossing: boolean }): Game {
    const crossing: Record<string, unknown> = {
      type: "teleport_player",
      mapId: "island",
      x: 1,
      y: 1,
    };
    if (opts.gateCrossing) crossing.when = { flag: "fare_paid" };
    const result = validateGame({
      meta: { id: "tp", title: "TP", goal: "cross" },
      legend: {
        "#": { name: "wall", glyph: "#", walkable: false },
        ".": { name: "floor", glyph: ".", walkable: true },
      },
      maps: {
        shore: {
          rows: ["#####", "#...#", "#####"],
          entities: [
            {
              id: "ferryman", name: "Ferryman", glyph: "F", x: 3, y: 1,
              interactions: [
                {
                  commands: [
                    { type: "set_flag", flag: "fare_paid" },
                    crossing,
                  ],
                },
              ],
            },
          ],
          triggers: [
            {
              id: "court-scene",
              on: "enter",
              commands: [
                { type: "set_tile", mapId: "court", x: 1, y: 1, char: "." },
                { type: "teleport_player", mapId: "court", x: 2, y: 1, when: { flag: "summoned" } },
              ],
            },
          ],
        },
        island: {
          rows: ["####", "#..#", "####"],
          entities: [
            {
              id: "hermit", name: "Hermit", glyph: "H", x: 2, y: 1,
              interactions: [
                { commands: [{ type: "set_flag", flag: "summoned" }, { type: "win", text: "Across." }] },
              ],
            },
          ],
        },
        court: { rows: ["####", "#..#", "####"], entities: [] },
      },
      player: { glyph: "@", map: "shore", x: 1, y: 1 },
    });
    expect(result.errors).toEqual([]);
    return result.game!;
  }

  it("an ungated teleport makes its destination reachable in BOTH passes", () => {
    const report = analyzeReachability(teleportFixture({ gateCrossing: false }));
    const island = report.maps.find((m) => m.id === "island")!;
    expect(island.optimistic).toBe(true);
    expect(island.pessimistic).toBe(true);
    expect(report.unreachableMaps).toEqual([]);
    // The hermit behind the teleport is interactable.
    expect(report.unreachableEntities).toEqual([]);
  });

  it("a when-gated teleport fires only in the optimistic pass (destination shows as flag-gated)", () => {
    const report = analyzeReachability(teleportFixture({ gateCrossing: true }));
    const island = report.maps.find((m) => m.id === "island")!;
    expect(island.optimistic).toBe(true);
    expect(island.pessimistic).toBe(false);
    expect(report.flagGatedMaps).toContain("island");
    expect(report.unreachableMaps).toEqual([]);
  });

  it("teleport edges chain to a fixpoint: a gated trigger teleport opens the court optimistically", () => {
    const report = analyzeReachability(teleportFixture({ gateCrossing: false }));
    const court = report.maps.find((m) => m.id === "court")!;
    expect(court.optimistic).toBe(true); // via the enter trigger's gated teleport
    expect(court.pessimistic).toBe(false); // gated: optimistic-pass only
  });

  it("reports the teleport list and the honest static-analysis limitations", () => {
    const report = analyzeReachability(teleportFixture({ gateCrossing: true }));
    expect(report.teleports).toHaveLength(2);
    const ferry = report.teleports.find((t) => t.source.includes("ferryman"))!;
    expect(ferry).toMatchObject({ toMap: "island", toX: 1, toY: 1, gated: true });
    const court = report.teleports.find((t) => t.source.includes("court-scene"))!;
    expect(court).toMatchObject({ toMap: "court", gated: true });
    // set_tile is used, so the overlay limitation is stated.
    expect(report.limitations.some((l) => l.includes("set_tile"))).toBe(true);
    expect(report.limitations.some((l) => l.includes("teleport_player"))).toBe(true);
    // A game with none of that reports no limitations.
    const plain = analyzeReachability(loadGame("games/demo/game.json"));
    expect(plain.teleports).toEqual([]);
    expect(plain.limitations).toEqual([]);
  });
});
