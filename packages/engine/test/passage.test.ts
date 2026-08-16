import { describe, expect, it } from "vitest";
import { Sim, observe, validateGame, type Game } from "../src/index.js";

/**
 * djt.7 (engine half) — long-form passages: the `passage` command's event
 * formatting, `state.lastPassages` lifecycle (cleared per act, like
 * lastEvents), full-length observer output, when-gating, and snapshots.
 */

const miniCatalog = {
  typeChart: { types: ["normal"], effectiveness: {} },
  moves: [
    { id: "tap", name: "Tap", type: "normal", power: 10, accuracy: 1, pp: 10 },
  ],
  species: [
    {
      id: "critter", name: "Critter", glyph: "c", types: ["normal"],
      baseStats: { hp: 30, atk: 20, def: 20, spd: 10 },
      learnset: [{ level: 1, moveId: "tap" }],
      catchRate: 0.5, xpYield: 10,
    },
  ],
  items: [],
};

function fixture(commands: unknown[]): unknown {
  return {
    meta: { id: "passage-test", title: "Passage Test", goal: "read the words" },
    catalog: structuredClone(miniCatalog),
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          { id: "reader", name: "Reader", glyph: "R", x: 2, y: 1, interactions: [{ commands }] },
        ],
      },
    },
    player: { glyph: "@", map: "main", x: 1, y: 1 },
  };
}

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

const FULL = {
  type: "passage",
  title: "The Whirlwind",
  lines: ["Where were you when I laid", "the foundations of the earth?"],
  citation: "Job 38:4",
};

describe("passage command", () => {
  it("formats title, blank line, lines, and citation into one event", () => {
    const sim = new Sim(load(fixture([FULL])), 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain(
      "The Whirlwind\n\nWhere were you when I laid\nthe foundations of the earth?\n— Job 38:4",
    );
  });

  it("omits the title block and citation line when absent", () => {
    const sim = new Sim(
      load(fixture([{ type: "passage", lines: ["A single line."] }])),
      1,
    );
    expect(sim.act({ type: "interact" })).toContain("A single line.");
    expect(sim.state.lastPassages).toEqual([{ lines: ["A single line."] }]);
  });

  it("appends to state.lastPassages, which clears at the start of the next act", () => {
    const sim = new Sim(load(fixture([FULL, { type: "say", text: "So." }])), 1);
    sim.act({ type: "interact" });
    expect(sim.state.lastPassages).toEqual([
      {
        title: "The Whirlwind",
        lines: ["Where were you when I laid", "the foundations of the earth?"],
        citation: "Job 38:4",
      },
    ]);
    // Events and passages travel together for the same act.
    expect(sim.state.lastEvents.at(-1)).toBe('Reader: "So."');
    sim.act({ type: "move", dir: "west" });
    expect(sim.state.lastPassages).toEqual([]);
  });

  it("clears lastPassages even on guard-path acts (already-won)", () => {
    const sim = new Sim(load(fixture([FULL, { type: "win", text: "Done." }])), 1);
    sim.act({ type: "interact" });
    expect(sim.state.lastPassages.length).toBe(1);
    sim.act({ type: "interact" });
    expect(sim.state.lastPassages).toEqual([]);
    expect(sim.state.lastEvents).toEqual(["The game is already won. Reset to play again."]);
  });

  it("observe prints every passage line in full", () => {
    const sim = new Sim(load(fixture([FULL])), 1);
    sim.act({ type: "interact" });
    const text = observe(sim);
    expect(text).toContain("The Whirlwind");
    expect(text).toContain("Where were you when I laid");
    expect(text).toContain("the foundations of the earth?");
    expect(text).toContain("— Job 38:4");
  });

  it("respects a when gate like any other command", () => {
    const sim = new Sim(
      load(fixture([{ ...FULL, when: { flag: "worthy" } }])),
      1,
    );
    const events = sim.act({ type: "interact" });
    expect(events.some((e) => e.includes("Whirlwind"))).toBe(false);
    expect(sim.state.lastPassages).toEqual([]);
  });

  it("round-trips lastPassages through a snapshot", () => {
    const game = load(fixture([FULL]));
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    const restored = Sim.fromSnapshot(game, snap);
    expect(restored.state.lastPassages).toEqual(sim.state.lastPassages);
  });

  it("requires at least one line", () => {
    const r = validateGame(fixture([{ type: "passage", lines: [] }]));
    expect(r.ok).toBe(false);
  });
});
