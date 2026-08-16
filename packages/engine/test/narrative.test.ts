import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Sim, observe, validateGame, type Game } from "../src/index.js";

/**
 * djt.6 (engine half) — catalog-free narrative games are first-class: they
 * validate, play, snapshot, and observe cleanly, while every battle-dependent
 * feature errors with a message naming the fix. Existing (catalog) games'
 * validation results are pinned unchanged.
 */

/** Two-map narrative game: no catalog, no party, no battles. */
function narrativeFixture(): {
  meta: object;
  legend: Record<string, object>;
  maps: Record<string, { rows: string[]; entities?: unknown[]; portals?: unknown[]; encounters?: unknown }>;
  player: Record<string, unknown>;
  catalog?: unknown;
} {
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
                  { type: "say", text: "The shrine is east. Go gently." },
                  { type: "set_flag", flag: "blessed" },
                  { type: "add_var", var: "kindness", amount: 1 },
                  { type: "give_money", amount: 3 },
                  { type: "heal_party" },
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
                when: { all: [{ flag: "blessed" }, { var: "kindness", op: "gte", value: 1 }] },
                commands: [
                  {
                    type: "passage",
                    title: "At the Shrine",
                    lines: ["The road behind you settles.", "The quiet here is full, not empty."],
                  },
                  { type: "win", text: "You kneel, and the road is complete." },
                ],
              },
              { commands: [{ type: "say", text: "The altar waits for a blessing you don't carry." }] },
            ],
          },
        ],
      },
    },
    player: { glyph: "@", map: "road", x: 2, y: 1, money: 0 },
  };
}

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

describe("catalog-free validation", () => {
  it("a narrative game with no catalog validates clean", () => {
    const r = validateGame(narrativeFixture());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.game!.catalog).toBeUndefined();
  });

  it("errors actionably on wild tiles", () => {
    const raw = narrativeFixture();
    raw.legend["*"] = { name: "tall grass", glyph: "*", walkable: true, wild: true };
    raw.maps.road.rows = ["#####", "#.*.#", "#####"];
    const r = validateGame(raw);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("wild tiles") && e.includes('add a top-level "catalog"'))).toBe(true);
  });

  it("errors actionably on an encounters zone", () => {
    const raw = narrativeFixture();
    raw.maps.road.encounters = {
      rate: 0.2,
      table: [{ speciesId: "ghost", minLevel: 1, maxLevel: 2, weight: 1 }],
    };
    const r = validateGame(raw);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.startsWith("maps.road.encounters:") && e.includes("remove the encounters zone")),
    ).toBe(true);
  });

  it("errors actionably on a trainer entity", () => {
    const raw = narrativeFixture();
    (raw.maps.road.entities![0] as Record<string, unknown>).trainer = {
      party: [{ speciesId: "ghost", level: 5 }],
      defeatFlag: "pilgrim_beaten",
    };
    const r = validateGame(raw);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.includes(".trainer:") && e.includes("remove the trainer block")),
    ).toBe(true);
  });

  it("errors actionably on give_species, give_item, and sell commands", () => {
    const cases: [object, string][] = [
      [{ type: "give_species", speciesId: "ghost", level: 5 }, "give_species"],
      [{ type: "give_item", itemId: "salve", qty: 1 }, "give_item"],
      [{ type: "sell", itemId: "salve", price: 5 }, "sell"],
    ];
    for (const [cmd, name] of cases) {
      const raw = narrativeFixture();
      (raw.maps.road.entities![0] as { interactions: { commands: object[] }[] }).interactions = [
        { commands: [cmd] },
      ];
      const r = validateGame(raw);
      expect(r.ok).toBe(false);
      expect(
        r.errors.some((e) => e.includes(name) && e.includes('add a top-level "catalog"')),
        `${name} should error actionably`,
      ).toBe(true);
    }
  });

  it("errors actionably on a starting party or inventory", () => {
    const withParty = narrativeFixture();
    withParty.player.party = [{ speciesId: "ghost", level: 5 }];
    const r1 = validateGame(withParty);
    expect(r1.ok).toBe(false);
    expect(r1.errors.some((e) => e.startsWith("player.party:") && e.includes('set "party": []'))).toBe(true);

    const withItems = narrativeFixture();
    withItems.player.inventory = [{ itemId: "salve", qty: 2 }];
    const r2 = validateGame(withItems);
    expect(r2.ok).toBe(false);
    expect(
      r2.errors.some((e) => e.startsWith("player.inventory:") && e.includes('set "inventory": []')),
    ).toBe(true);
  });
});

describe("catalog-free play", () => {
  it("plays to the win through flags, vars, portals, and a passage", () => {
    const sim = new Sim(load(narrativeFixture()), 1);
    let events = sim.act({ type: "interact" }); // pilgrim blesses
    expect(events).toContain('Pilgrim: "The shrine is east. Go gently."');
    expect(events).toContain("You rest a while by the warmth."); // heal_party no-op
    expect(sim.state.money).toBe(3);
    expect(sim.state.vars.kindness).toBe(1);
    sim.act({ type: "move", dir: "east" }); // onto the portal -> shrine
    expect(sim.state.map).toBe("shrine");
    events = sim.act({ type: "interact" }); // altar
    expect(events.some((e) => e.includes("At the Shrine"))).toBe(true);
    expect(sim.state.lastPassages.length).toBe(1);
    expect(sim.state.won).toBe(true);
    expect(sim.state.battle).toBeNull();
  });

  it("second pilgrim chat falls through to the ungated line", () => {
    const sim = new Sim(load(narrativeFixture()), 1);
    sim.act({ type: "interact" });
    expect(sim.act({ type: "interact" })).toContain('Pilgrim: "Go on, now."');
  });

  it("observe shows money but no party line, and full passages", () => {
    const sim = new Sim(load(narrativeFixture()), 1);
    sim.act({ type: "interact" });
    const text = observe(sim);
    expect(text).toContain("Money: 3");
    expect(text).not.toContain("Party:");
    sim.act({ type: "move", dir: "east" });
    sim.act({ type: "interact" });
    const shrineText = observe(sim);
    expect(shrineText).toContain("The quiet here is full, not empty.");
  });

  it("snapshots round-trip without a catalog", () => {
    const game = load(narrativeFixture());
    const sim = new Sim(game, 9);
    sim.act({ type: "interact" });
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    const restored = Sim.fromSnapshot(game, snap);
    expect(restored.state).toEqual(sim.state);
    restored.act({ type: "move", dir: "east" });
    expect(restored.state.map).toBe("shrine");
  });
});

describe("existing games are untouched by the optional catalog", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  for (const rel of ["games/demo/game.json", "games/emberwood/game.json"]) {
    it(`${rel} still validates with zero errors and zero warnings`, () => {
      const r = validateGame(JSON.parse(readFileSync(`${ROOT}${rel}`, "utf8")));
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.game!.catalog).toBeDefined();
    });
  }
});
