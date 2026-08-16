import { describe, expect, it } from "vitest";
import {
  GameSchema,
  Sim,
  observe,
  renderGrid,
  validateGame,
  type Game,
} from "../src/index.js";

/**
 * djt.5 — conditional entity appearance: `variants` (first when-match wins,
 * base fields as fallback), `set_variant` forcing via state.variantOverrides
 * (override beats when-evaluation until cleared), effective glyph/name in
 * every observer surface (grid, nearby list, say speaker names), sprite
 * passthrough for the web layer, validation, and snapshot round-trips.
 */

/**
 * Job stands east of the player. Variants: afflicted (boils flag), restored
 * (fortune >= 2) — declaration order decides ties.
 */
function fixture(extra: { entities?: unknown[]; interactions?: unknown[] } = {}): unknown {
  return {
    meta: { id: "variant-test", title: "Variant Test", goal: "test variants" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          {
            id: "job", name: "Job", glyph: "J", x: 2, y: 1, sprite: "job-base",
            variants: [
              { id: "afflicted", when: { flag: "boils" }, glyph: "j",
                name: "Job the Afflicted", sprite: "job-boils" },
              { id: "restored", when: { var: "fortune", op: "gte", value: 2 },
                glyph: "Ĵ", name: "Job the Restored" },
            ],
            interactions: extra.interactions ?? [
              { commands: [{ type: "say", text: "The LORD gave." }] },
            ],
          },
          ...(extra.entities ?? []),
        ],
      },
    },
    player: { glyph: "@", map: "main", x: 1, y: 1 },
  };
}

/** Helper entity whose interaction runs arbitrary commands. */
const director = (commands: unknown[]): unknown => ({
  id: "director", name: "Director", glyph: "D", x: 3, y: 1, blocking: false,
  interactions: [{ commands }],
});

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  // Writers for the tested flags/vars live outside this fixture; ignore
  // read-never-written warnings here.
  return result.game!;
}

/** Fixture with a director that can set flags/vars (silences warnings). */
function playable(commands: unknown[]): Game {
  return load(fixture({ entities: [director(commands)] }));
}

describe("variant evaluation", () => {
  it("base appearance while no variant matches", () => {
    const sim = new Sim(playable([{ type: "set_flag", flag: "boils" }, { type: "add_var", var: "fortune", amount: 1 }]), 1);
    expect(sim.entityAt(2, 1)!.glyph).toBe("J");
    expect(sim.entityAt(2, 1)!.name).toBe("Job");
    expect(sim.entityAt(2, 1)!.sprite).toBe("job-base");
    expect(renderGrid(sim).split("\n")[1]).toBe("#@JD#");
  });

  it("a matching when switches glyph, name, and sprite everywhere", () => {
    const sim = new Sim(playable([{ type: "set_flag", flag: "boils" }]), 1);
    sim.act({ type: "move", dir: "east" }); // bump Job: base name in the event
    expect(sim.state.lastEvents).toContain('Job is standing there. Try "interact".');
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Job: "The LORD gave."'); // still base pre-flag

    // The director sets the boils flag... but Job is between. Walk around? No:
    // the map is one corridor — interact hits Job first. Instead run the flag
    // through a fresh sim below.
    const withFlag = new Sim(playable([{ type: "set_flag", flag: "boils" }, { type: "add_var", var: "fortune", amount: 1 }]), 1);
    withFlag.state.flags.push("boils"); // simulate the flag having been earned
    expect(withFlag.entityAt(2, 1)!.glyph).toBe("j");
    expect(withFlag.entityAt(2, 1)!.name).toBe("Job the Afflicted");
    expect(withFlag.entityAt(2, 1)!.sprite).toBe("job-boils");
    expect(renderGrid(withFlag).split("\n")[1]).toBe("#@jD#");
    expect(observe(withFlag)).toContain("j Job the Afflicted — 1 east");
    // Dialogue speaker names use the effective name.
    const said = withFlag.act({ type: "interact" });
    expect(said).toContain('Job the Afflicted: "The LORD gave."');
  });

  it("first when-match wins; fields missing on the variant fall back to base", () => {
    const sim = new Sim(playable([{ type: "set_flag", flag: "boils" }, { type: "add_var", var: "fortune", amount: 1 }]), 1);
    sim.state.flags.push("boils");
    sim.state.vars.fortune = 5; // both variants match: "afflicted" is first
    expect(sim.entityAt(2, 1)!.name).toBe("Job the Afflicted");
    sim.state.flags.length = 0; // only "restored" matches now
    const e = sim.entityAt(2, 1)!;
    expect(e.name).toBe("Job the Restored");
    expect(e.glyph).toBe("Ĵ");
    expect(e.sprite).toBe("job-base"); // no sprite on the variant: base wins
  });

  it("var-comparison whens read state.vars", () => {
    const sim = new Sim(playable([{ type: "add_var", var: "fortune", amount: 2 }]), 1);
    sim.act({ type: "move", dir: "east" }); // blocked by Job — stays put
    // Reach the director? Job blocks the corridor; fire it via choice-free
    // direct state instead: vars are the surface being tested.
    sim.state.vars.fortune = 2;
    expect(sim.entityAt(2, 1)!.name).toBe("Job the Restored");
  });
});

describe("set_variant", () => {
  it("forces a variant even when its when fails, beats when-evaluation, clears", () => {
    const game = load(
      fixture({
        entities: [
          director([
            { type: "set_flag", flag: "boils" }, // "afflicted" would win
            { type: "set_variant", entityId: "job", variantId: "restored" },
          ]),
        ],
      }),
    );
    const sim = new Sim(game, 1);
    // The director is at (3,1) behind Job — but execFrames runs on interact
    // with the FIRST adjacent entity. Job is adjacent; director is not.
    // Drive the commands by teleporting the state directly instead:
    sim.state.flags.push("boils");
    sim.state.variantOverrides.job = "restored";
    expect(sim.entityAt(2, 1)!.name).toBe("Job the Restored"); // override wins
    delete sim.state.variantOverrides.job;
    expect(sim.entityAt(2, 1)!.name).toBe("Job the Afflicted"); // back to when
  });

  it("runs from a command list and re-resolves speaker names mid-sequence", () => {
    const game = load(
      fixture({
        interactions: [
          {
            commands: [
              { type: "say", text: "I am myself." },
              { type: "set_variant", entityId: "job", variantId: "afflicted" },
              { type: "say", text: "And now I am not." },
            ],
          },
        ],
      }),
    );
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Job: "I am myself."');
    expect(events).toContain('Job the Afflicted: "And now I am not."');
    expect(sim.state.variantOverrides).toEqual({ job: "afflicted" });

    // clear: true returns to when-evaluation (no flags set: base).
    const events2 = sim.act({ type: "interact" });
    expect(events2).toContain('Job the Afflicted: "I am myself."'); // still forced
    const cleared = new Sim(
      load(
        fixture({
          interactions: [
            { commands: [
              { type: "set_variant", entityId: "job", variantId: "afflicted" },
              { type: "set_variant", entityId: "job", clear: true },
              { type: "say", text: "Whole again." },
            ] },
          ],
        }),
      ),
      1,
    );
    const ev = cleared.act({ type: "interact" });
    expect(ev).toContain('Job: "Whole again."');
    expect(cleared.state.variantOverrides).toEqual({});
  });

  it("a stale forced id (unvalidated/edited game) falls back to when-evaluation", () => {
    const game = GameSchema.parse(fixture());
    const sim = new Sim(game, 1);
    sim.state.variantOverrides.job = "no-such-variant";
    expect(sim.entityAt(2, 1)!.name).toBe("Job"); // base — no variant matches
    sim.state.flags.push("boils");
    expect(sim.entityAt(2, 1)!.name).toBe("Job the Afflicted");
  });

  it("set_variant on an unknown variant is a runtime event in unvalidated games", () => {
    const raw = fixture({
      interactions: [
        { commands: [{ type: "set_variant", entityId: "job", variantId: "ghost" }] },
      ],
    });
    const sim = new Sim(GameSchema.parse(raw), 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Nothing happens — "ghost" is not a variant of "job".');
  });
});

describe("variants on spawned entities", () => {
  it("spawned entities evaluate variants and accept set_variant", () => {
    const spawned = {
      id: "messenger", name: "Messenger", glyph: "m", x: 3, y: 1,
      variants: [{ id: "grim", glyph: "M", name: "Grim Messenger" }], // no when: always
      interactions: [],
    };
    const game = load(
      fixture({
        interactions: [
          { commands: [{ type: "spawn_entity", entity: spawned }] },
        ],
      }),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    // The when-less variant always matches.
    const e = sim.entitiesOn("main").find((x) => x.id === "messenger")!;
    expect(e.name).toBe("Grim Messenger");
    expect(e.glyph).toBe("M");
  });

  it("validation resolves set_variant refs against spawn_entity payloads", () => {
    const ok = validateGame(
      fixture({
        interactions: [
          {
            commands: [
              { type: "spawn_entity", entity: {
                id: "messenger", name: "Messenger", glyph: "m", x: 3, y: 1,
                variants: [{ id: "grim", glyph: "M" }],
              } },
              { type: "set_variant", entityId: "messenger", variantId: "grim" },
            ],
          },
        ],
      }),
    );
    expect(ok.errors).toEqual([]);
  });
});

describe("validation", () => {
  it("requires unique variant ids per entity", () => {
    const raw = fixture() as { maps: { main: { entities: { variants?: unknown[] }[] } } };
    raw.maps.main.entities[0].variants = [
      { id: "twin", glyph: "a" },
      { id: "twin", glyph: "b" },
    ];
    const r = validateGame(raw);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes("maps.main.entities.job.variants[1]") && e.includes('duplicate variant id "twin"'),
      ),
    ).toBe(true);
  });

  it("checks set_variant refs: unknown entity, unknown variant, exactly-one rule", () => {
    const bad = (cmd: object) =>
      validateGame(fixture({ interactions: [{ commands: [cmd] }] }));

    const unknownEntity = bad({ type: "set_variant", entityId: "nobody", variantId: "x" });
    expect(unknownEntity.errors.some((e) => e.includes('entityId "nobody" is not a defined entity'))).toBe(true);

    const unknownVariant = bad({ type: "set_variant", entityId: "job", variantId: "ghost" });
    expect(
      unknownVariant.errors.some((e) =>
        e.includes('variantId "ghost" is not a variant of "job"') &&
        e.includes("afflicted, restored"),
      ),
    ).toBe(true);

    const both = bad({ type: "set_variant", entityId: "job", variantId: "afflicted", clear: true });
    expect(both.errors.some((e) => e.includes("exactly one of"))).toBe(true);

    const neither = bad({ type: "set_variant", entityId: "job" });
    expect(neither.errors.some((e) => e.includes("exactly one of"))).toBe(true);
  });

  it("variant whens count as flag/var reads (warns when never written)", () => {
    const r = validateGame(fixture());
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('"boils"') && w.includes("never set"))).toBe(true);
    expect(r.warnings.some((w) => w.includes('"fortune"') && w.includes("never written"))).toBe(true);
    // With writers present, the warnings clear.
    const clean = validateGame(
      fixture({
        entities: [
          director([
            { type: "set_flag", flag: "boils" },
            { type: "add_var", var: "fortune", amount: 1 },
          ]),
        ],
      }),
    );
    expect(clean.warnings).toEqual([]);
  });
});

describe("snapshots", () => {
  it("variantOverrides round-trip and appearance survives restore", () => {
    const game = load(
      fixture({
        interactions: [
          { commands: [{ type: "set_variant", entityId: "job", variantId: "afflicted" }] },
        ],
      }),
    );
    const sim = new Sim(game, 7);
    sim.act({ type: "interact" });
    const restored = Sim.fromSnapshot(game, JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.state.variantOverrides).toEqual({ job: "afflicted" });
    expect(restored.entityAt(2, 1)!.name).toBe("Job the Afflicted");
    expect(restored.state).toEqual(sim.state);
  });
});
