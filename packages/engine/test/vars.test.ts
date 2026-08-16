import { describe, expect, it } from "vitest";
import {
  Sim,
  evalWhen,
  validateGame,
  type Game,
  type Interaction,
  type WhenContext,
} from "../src/index.js";

/**
 * djt.1 — variables and unified `when` conditions: the evalWhen matrix,
 * set_var/add_var semantics, per-command and per-interaction gating,
 * validation cross-checks/warnings, and snapshot round-trips.
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

/** One-room game with a single NPC ("sage") east of the player. */
function fixture(interactions: unknown[], opts: { money?: number } = {}): unknown {
  return {
    meta: { id: "vars-test", title: "Vars Test", goal: "test vars" },
    catalog: structuredClone(miniCatalog),
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          { id: "sage", name: "Sage", glyph: "S", x: 2, y: 1, interactions },
        ],
      },
    },
    player: { glyph: "@", map: "main", x: 1, y: 1, money: opts.money ?? 0 },
  };
}

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

const ctx = (over: Partial<WhenContext> = {}): WhenContext => ({
  flags: [],
  vars: {},
  money: 0,
  ...over,
});

describe("evalWhen", () => {
  it("flag / notFlag", () => {
    const c = ctx({ flags: ["seen"] });
    expect(evalWhen(c, { flag: "seen" })).toBe(true);
    expect(evalWhen(c, { flag: "other" })).toBe(false);
    expect(evalWhen(c, { notFlag: "seen" })).toBe(false);
    expect(evalWhen(c, { notFlag: "other" })).toBe(true);
  });

  it("numeric comparisons, all six ops", () => {
    const c = ctx({ vars: { n: 5 } });
    const t = (op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte", value: number) =>
      evalWhen(c, { var: "n", op, value });
    expect(t("eq", 5)).toBe(true);
    expect(t("eq", 4)).toBe(false);
    expect(t("ne", 4)).toBe(true);
    expect(t("ne", 5)).toBe(false);
    expect(t("lt", 6)).toBe(true);
    expect(t("lt", 5)).toBe(false);
    expect(t("lte", 5)).toBe(true);
    expect(t("lte", 4)).toBe(false);
    expect(t("gt", 4)).toBe(true);
    expect(t("gt", 5)).toBe(false);
    expect(t("gte", 5)).toBe(true);
    expect(t("gte", 6)).toBe(false);
  });

  it("string comparisons are lexical", () => {
    const c = ctx({ vars: { mood: "calm" } });
    expect(evalWhen(c, { var: "mood", op: "eq", value: "calm" })).toBe(true);
    expect(evalWhen(c, { var: "mood", op: "lt", value: "storm" })).toBe(true);
    expect(evalWhen(c, { var: "mood", op: "gt", value: "storm" })).toBe(false);
  });

  it("missing var reads as 0 against numbers and \"\" against strings", () => {
    const c = ctx();
    expect(evalWhen(c, { var: "ghost", op: "eq", value: 0 })).toBe(true);
    expect(evalWhen(c, { var: "ghost", op: "lt", value: 1 })).toBe(true);
    expect(evalWhen(c, { var: "ghost", op: "gte", value: 1 })).toBe(false);
    expect(evalWhen(c, { var: "ghost", op: "eq", value: "" })).toBe(true);
    expect(evalWhen(c, { var: "ghost", op: "ne", value: "x" })).toBe(true);
  });

  it("type-mismatched comparisons: only ne is true", () => {
    const c = ctx({ vars: { s: "seven" } });
    for (const op of ["eq", "lt", "lte", "gt", "gte"] as const) {
      expect(evalWhen(c, { var: "s", op, value: 7 })).toBe(false);
    }
    expect(evalWhen(c, { var: "s", op: "ne", value: 7 })).toBe(true);
  });

  it("money is a built-in readable var (and shadows any vars entry)", () => {
    const c = ctx({ money: 30, vars: { money: 999 } });
    expect(evalWhen(c, { var: "money", op: "gte", value: 30 })).toBe(true);
    expect(evalWhen(c, { var: "money", op: "eq", value: 999 })).toBe(false);
  });

  it("all / any / not compose and nest", () => {
    const c = ctx({ flags: ["a"], vars: { n: 2 } });
    expect(
      evalWhen(c, { all: [{ flag: "a" }, { var: "n", op: "gt", value: 1 }] }),
    ).toBe(true);
    expect(
      evalWhen(c, { all: [{ flag: "a" }, { flag: "b" }] }),
    ).toBe(false);
    expect(
      evalWhen(c, { any: [{ flag: "b" }, { var: "n", op: "eq", value: 2 }] }),
    ).toBe(true);
    expect(evalWhen(c, { any: [{ flag: "b" }, { flag: "c" }] })).toBe(false);
    expect(evalWhen(c, { not: { flag: "b" } })).toBe(true);
    expect(
      evalWhen(c, {
        not: { any: [{ flag: "b" }, { all: [{ flag: "a" }, { notFlag: "b" }] }] },
      }),
    ).toBe(false);
  });
});

describe("When schema", () => {
  const withWhen = (when: unknown) =>
    validateGame(
      fixture([{ commands: [{ type: "say", text: "hi", when }] }]),
    );

  it("accepts nested composition", () => {
    const r = withWhen({
      all: [{ flag: "a" }, { any: [{ var: "n", op: "gte", value: 1 }, { not: { notFlag: "b" } }] }],
    });
    // "a"/"b" are read-never-set and "n" read-never-written: warnings, not errors.
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(3);
  });

  it("rejects an unknown op", () => {
    const r = withWhen({ var: "n", op: "between", value: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown keys (strict variants)", () => {
    const r = withWhen({ flag: "a", extra: true });
    expect(r.ok).toBe(false);
  });

  it("rejects an empty all/any", () => {
    expect(withWhen({ all: [] }).ok).toBe(false);
    expect(withWhen({ any: [] }).ok).toBe(false);
  });
});

describe("set_var / add_var", () => {
  function talk(interactions: unknown[], times = 1, opts: { money?: number } = {}): Sim {
    const sim = new Sim(load(fixture(interactions, opts)), 1);
    for (let i = 0; i < times; i++) sim.act({ type: "interact" });
    return sim;
  }

  it("set_var writes numbers and strings; add_var accumulates", () => {
    const sim = talk(
      [
        {
          commands: [
            { type: "set_var", var: "mood", value: "bright" },
            { type: "set_var", var: "count", value: 10 },
            { type: "add_var", var: "count", amount: -3 },
          ],
        },
      ],
    );
    expect(sim.state.vars).toEqual({ mood: "bright", count: 7 });
  });

  it("add_var on a missing var starts from 0", () => {
    const sim = talk([{ commands: [{ type: "add_var", var: "steps", amount: 2 }] }], 3);
    expect(sim.state.vars.steps).toBe(6);
  });

  it("add_var on a string var (runtime-only ambiguity) emits an event and leaves it unchanged", () => {
    // A numeric set_var exists elsewhere, so validation can't call it statically.
    const sim = talk(
      [
        {
          commands: [
            { type: "set_var", var: "x", value: "oops", when: { notFlag: "later" } },
            { type: "set_var", var: "x", value: 1, when: { flag: "later" } },
            { type: "add_var", var: "x", amount: 5 },
          ],
        },
      ],
    );
    expect(sim.state.vars.x).toBe("oops");
    expect(sim.state.lastEvents).toContain(
      'Nothing happens — "x" holds text ("oops"), not a number.',
    );
  });

  it("statically-knowable add_var-on-text is a validation error", () => {
    const r = validateGame(
      fixture([
        {
          commands: [
            { type: "set_var", var: "x", value: "text" },
            { type: "add_var", var: "x", amount: 1 },
          ],
        },
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('add_var needs "x" to hold a number'))).toBe(true);
  });

  it("mixed numeric/text writes are not a static error", () => {
    const r = validateGame(
      fixture([
        {
          commands: [
            { type: "set_var", var: "x", value: "text" },
            { type: "set_var", var: "x", value: 3 },
            { type: "add_var", var: "x", amount: 1 },
          ],
        },
      ]),
    );
    expect(r.ok).toBe(true);
  });

  it("writing the built-in money var is a validation error", () => {
    for (const cmd of [
      { type: "set_var", var: "money", value: 100 },
      { type: "add_var", var: "money", amount: 100 },
    ]) {
      const r = validateGame(fixture([{ commands: [cmd] }]));
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("built-in money counter"))).toBe(true);
    }
  });
});

describe("when gating", () => {
  it("gates individual commands silently", () => {
    const game = load(
      fixture([
        {
          commands: [
            { type: "say", text: "Always." },
            { type: "say", text: "Never.", when: { flag: "no-such" } },
            { type: "give_money", amount: 5, when: { var: "money", op: "eq", value: 0 } },
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Sage: "Always."');
    expect(events).not.toContain('Sage: "Never."');
    expect(sim.state.money).toBe(5);
    // Second visit: money is now 5, the gated give_money is skipped.
    sim.act({ type: "interact" });
    expect(sim.state.money).toBe(5);
  });

  it("gates whole interactions; first open one runs", () => {
    const rich: Interaction = {
      when: { var: "money", op: "gte", value: 10 },
      commands: [{ type: "say", text: "You can afford it." }],
    };
    const poor: Interaction = { commands: [{ type: "say", text: "Come back richer." }] };
    const game = load(fixture([rich, poor], { money: 3 }));
    const sim = new Sim(game, 1);
    expect(sim.act({ type: "interact" })).toContain('Sage: "Come back richer."');
    sim.state.money = 12;
    expect(sim.act({ type: "interact" })).toContain('Sage: "You can afford it."');
  });

  it("ANDs when with the requiresFlag/forbidsFlag sugar", () => {
    const game = load(
      fixture([
        {
          requiresFlag: "met",
          when: { var: "trust", op: "gte", value: 2 },
          commands: [{ type: "say", text: "Old friend." }],
        },
        {
          commands: [
            { type: "say", text: "Hello, stranger." },
            { type: "set_flag", flag: "met" },
            { type: "add_var", var: "trust", amount: 1 },
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    expect(sim.act({ type: "interact" })).toContain('Sage: "Hello, stranger."');
    // met is set, but trust is only 1 — sugar passes, when fails.
    expect(sim.act({ type: "interact" })).toContain('Sage: "Hello, stranger."');
    expect(sim.act({ type: "interact" })).toContain('Sage: "Old friend."');
    expect(sim.state.vars.trust).toBe(2);
  });
});

describe("validation warnings", () => {
  it("warns on a var read but never written", () => {
    const r = validateGame(
      fixture([
        { commands: [{ type: "say", text: "hi", when: { var: "ghost", op: "gt", value: 0 } }] },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('"ghost" is read in a when condition but never written'))).toBe(true);
  });

  it("does not warn when the var is written somewhere", () => {
    const r = validateGame(
      fixture([
        {
          commands: [
            { type: "add_var", var: "ghost", amount: 1 },
            { type: "say", text: "hi", when: { var: "ghost", op: "gt", value: 0 } },
          ],
        },
      ]),
    );
    expect(r.warnings).toEqual([]);
  });

  it("never counts the built-in money var as unwritten", () => {
    const r = validateGame(
      fixture([
        { commands: [{ type: "say", text: "hi", when: { var: "money", op: "gte", value: 1 } }] },
      ]),
    );
    expect(r.warnings).toEqual([]);
  });

  it("warns on a flag read but never set", () => {
    const r = validateGame(
      fixture([{ requiresFlag: "never_set", commands: [{ type: "say", text: "hi" }] }]),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('"never_set" is read'))).toBe(true);
  });

  it("counts a trainer defeatFlag as a flag write", () => {
    const raw = fixture([
      { requiresFlag: "sage_beaten", commands: [{ type: "say", text: "You won." }] },
    ]) as { maps: { main: { entities: { trainer?: unknown }[] } } };
    raw.maps.main.entities[0].trainer = {
      party: [{ speciesId: "critter", level: 3 }],
      defeatFlag: "sage_beaten",
    };
    const r = validateGame(raw);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("vars in snapshots and replays", () => {
  const interactions = [
    {
      commands: [
        { type: "set_var", var: "mood", value: "warm" },
        { type: "add_var", var: "visits", amount: 1 },
      ],
    },
  ];

  it("round-trips vars through snapshot/fromSnapshot", () => {
    const game = load(fixture(interactions));
    const sim = new Sim(game, 7);
    sim.act({ type: "interact" });
    sim.act({ type: "interact" });
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    const restored = Sim.fromSnapshot(game, snap);
    expect(restored.state.vars).toEqual({ mood: "warm", visits: 2 });
    restored.act({ type: "interact" });
    expect(restored.state.vars.visits).toBe(3);
  });

  it("tolerates pre-vars snapshots (vars/lastPassages default in)", () => {
    const game = load(fixture(interactions));
    const sim = new Sim(game, 7);
    const snap = sim.snapshot() as unknown as Record<string, unknown>;
    delete snap.vars;
    delete snap.lastPassages;
    const restored = Sim.fromSnapshot(game, snap as never);
    expect(restored.state.vars).toEqual({});
    expect(restored.state.lastPassages).toEqual([]);
  });

  it("replays deterministically: same seed + actions, same vars", () => {
    const game = load(fixture(interactions));
    const run = () => {
      const sim = new Sim(game, 42);
      sim.act({ type: "interact" });
      sim.act({ type: "move", dir: "west" });
      sim.act({ type: "interact" });
      return sim.state;
    };
    expect(run()).toEqual(run());
  });
});
