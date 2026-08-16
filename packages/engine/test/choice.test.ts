import { describe, expect, it } from "vitest";
import {
  Sim,
  observe,
  parseAction,
  validateGame,
  makeSaveFile,
  loadSaveFile,
  removeItem,
  type Command,
  type Game,
} from "../src/index.js";

/**
 * djt.2 — the `choice` dialogue command: presentation events and observe
 * output, when-gated options, empty-choice skip + static warning, the
 * suspend/resume continuation rule (say → choice → say-epilogue), nested
 * chains, choose/rejection semantics, mid-choice snapshot round-trips, and
 * validation recursion into option command lists.
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
  items: [{ id: "tonic", name: "Tonic", kind: "heal", amount: 10 }],
};

/** One-room game with a single NPC ("wife") east of the player. */
function fixture(interactions: unknown[], opts: { catalog?: boolean } = {}): unknown {
  return {
    meta: { id: "choice-test", title: "Choice Test", goal: "test choices" },
    ...(opts.catalog === false ? {} : { catalog: structuredClone(miniCatalog) }),
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          { id: "wife", name: "Wife", glyph: "W", x: 2, y: 1, interactions },
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

const choice = (prompt: string, options: unknown[]): unknown => ({
  type: "choice",
  prompt,
  options,
});

const say = (text: string): unknown => ({ type: "say", text });

describe("choice presentation", () => {
  const game = () =>
    load(
      fixture([
        {
          commands: [
            say("Curse God and die?"),
            choice("What do you answer?", [
              { label: "Hold fast", commands: [say("You hold fast.")] },
              { label: "Curse", commands: [say("You curse.")] },
            ]),
          ],
        },
      ]),
    );

  it("pushes the prompt, numbered labels, and a choose hint as events", () => {
    const sim = new Sim(game(), 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Wife: "Curse God and die?"');
    expect(events).toContain("What do you answer?");
    expect(events).toContain("1) Hold fast");
    expect(events).toContain("2) Curse");
    expect(events).toContain("Choose an option: choose1..choose2.");
    expect(sim.state.pendingChoice).not.toBeNull();
    expect(sim.state.pendingChoice!.options.map((o) => o.label)).toEqual([
      "Hold fast",
      "Curse",
    ]);
  });

  it("observe shows the prompt, numbered options, and choose actions", () => {
    const sim = new Sim(game(), 1);
    sim.act({ type: "interact" });
    const text = observe(sim);
    expect(text).toContain("Choice: What do you answer?");
    expect(text).toContain("  1) Hold fast");
    expect(text).toContain("  2) Curse");
    expect(text).toContain("Actions: choose1..choose2");
    expect(text).not.toContain("Actions: north");
  });
});

describe("option gating", () => {
  it("hides options whose when fails, preserving order and renumbering", () => {
    const game = load(
      fixture([
        {
          commands: [
            { type: "set_flag", flag: "met" },
            choice("Pick.", [
              { label: "Hidden", when: { notFlag: "met" }, commands: [say("no")] },
              { label: "First shown", commands: [say("first")] },
              { label: "Second shown", when: { flag: "met" }, commands: [say("second")] },
            ]),
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain("1) First shown");
    expect(events).toContain("2) Second shown");
    expect(events.some((e) => e.includes("Hidden"))).toBe(false);
    // choose1 maps to the first AVAILABLE option.
    const chosen = sim.act({ type: "choose", index: 0 });
    expect(chosen).toContain('Wife: "first"');
  });

  it("skips an empty choice with an explanatory event and runs what follows", () => {
    const game = load(
      fixture([
        {
          commands: [
            choice("A door with no handles.", [
              { label: "Never", when: { flag: "ghost" }, commands: [say("no")] },
            ]),
            say("Life goes on."),
            { type: "set_flag", flag: "ghost" },
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain(
      "A door with no handles. — but none of the options are open to you right now.",
    );
    expect(events).toContain('Wife: "Life goes on."');
    expect(sim.state.pendingChoice).toBeNull();
  });

  it("a when-gated choice command is skipped silently like any command", () => {
    const game = load(
      fixture([
        {
          commands: [
            { ...choice("Never asked.", [{ label: "x", commands: [say("x")] }]) as object, when: { flag: "nope" } },
            say("Just chatter."),
            { type: "set_flag", flag: "nope" },
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Wife: "Just chatter."');
    expect(events.some((e) => e.includes("Never asked"))).toBe(false);
    expect(sim.state.pendingChoice).toBeNull();
  });
});

describe("choose flow and continuations", () => {
  it("suspends the rest of the list; chosen commands run, then the epilogue", () => {
    const game = load(
      fixture([
        {
          commands: [
            say("Before."),
            choice("Well?", [
              { label: "Yes", commands: [say("You said yes.")] },
              { label: "No", commands: [say("You said no.")] },
            ]),
            say("Epilogue."),
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    const first = sim.act({ type: "interact" });
    expect(first).toContain('Wife: "Before."');
    // The epilogue must NOT have run yet — it is suspended.
    expect(first.some((e) => e.includes("Epilogue"))).toBe(false);
    const events = sim.act({ type: "choose", index: 1 });
    expect(events[0]).toBe("You choose: No");
    const noIdx = events.indexOf('Wife: "You said no."');
    const epiIdx = events.indexOf('Wife: "Epilogue."');
    expect(noIdx).toBeGreaterThan(-1);
    expect(epiIdx).toBeGreaterThan(noIdx);
    expect(sim.state.pendingChoice).toBeNull();
  });

  it("nested choices stack continuations and resume innermost first", () => {
    const game = load(
      fixture([
        {
          commands: [
            choice("Outer?", [
              {
                label: "Deeper",
                commands: [
                  say("Descending."),
                  choice("Inner?", [
                    { label: "Bottom", commands: [say("At the bottom.")] },
                  ]),
                  say("Inner epilogue."),
                ],
              },
            ]),
            say("Outer epilogue."),
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    const mid = sim.act({ type: "choose", index: 0 });
    expect(mid).toContain('Wife: "Descending."');
    expect(mid).toContain("Inner?");
    // Both epilogues still suspended behind the inner choice.
    expect(mid.some((e) => e.includes("epilogue"))).toBe(false);
    expect(sim.state.pendingChoice!.prompt).toBe("Inner?");
    expect(sim.state.pendingChoice!.continuations.length).toBe(2);
    const done = sim.act({ type: "choose", index: 0 });
    const order = [
      done.indexOf('Wife: "At the bottom."'),
      done.indexOf('Wife: "Inner epilogue."'),
      done.indexOf('Wife: "Outer epilogue."'),
    ];
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
    expect(sim.state.pendingChoice).toBeNull();
  });

  it("options can set flags/vars and give items", () => {
    const game = load(
      fixture([
        {
          commands: [
            choice("Take the tonic?", [
              {
                label: "Take it",
                commands: [
                  { type: "set_flag", flag: "took_tonic" },
                  { type: "add_var", var: "kindness", amount: 1 },
                  { type: "give_item", itemId: "tonic", qty: 1 },
                ],
              },
              { label: "Refuse", commands: [say("As you wish.")] },
            ]),
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    sim.act({ type: "choose", index: 0 });
    expect(sim.state.flags).toContain("took_tonic");
    expect(sim.state.vars.kindness).toBe(1);
    expect(sim.state.inventory).toEqual([{ itemId: "tonic", qty: 1 }]);
  });
});

describe("rejections while a choice is pending", () => {
  function pendingSim(): Sim {
    const game = load(
      fixture([
        {
          commands: [
            choice("Yes or no?", [
              { label: "Yes", commands: [say("yes")] },
              { label: "No", commands: [say("no")] },
            ]),
          ],
        },
      ]),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    return sim;
  }

  it("rejects out-of-range chooses with the valid range", () => {
    const sim = pendingSim();
    const events = sim.act({ type: "choose", index: 5 });
    expect(events).toContain("There is no option 6 — valid: choose1..choose2.");
    expect(sim.state.pendingChoice).not.toBeNull();
  });

  it("rejects movement and interact while pending, pointing at the options", () => {
    const sim = pendingSim();
    for (const action of [
      { type: "move", dir: "west" } as const,
      { type: "interact" } as const,
      { type: "battle_run" } as const,
    ]) {
      const events = sim.act(action);
      expect(events).toContain(
        "A choice is before you — pick an option: choose1..choose2.",
      );
    }
    expect(sim.state.playerX).toBe(1);
    expect(sim.state.pendingChoice).not.toBeNull();
  });

  it("rejects choose when no choice is pending", () => {
    const game = load(fixture([{ commands: [say("hi")] }]));
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "choose", index: 0 });
    expect(events).toContain(
      "There is no choice to make right now — valid actions: north | south | east | west | interact.",
    );
  });
});

describe("parseAction choose words", () => {
  it("parses choose1..choose9 and the o1..o9 alias", () => {
    expect(parseAction("choose1")).toEqual({ type: "choose", index: 0 });
    expect(parseAction("choose9")).toEqual({ type: "choose", index: 8 });
    expect(parseAction("o3")).toEqual({ type: "choose", index: 2 });
    expect(parseAction("choose0")).toBeUndefined();
    expect(parseAction("o")).toBeUndefined();
    // Existing words keep their meanings.
    expect(parseAction("c")).toBeUndefined();
    expect(parseAction("s")).toEqual({ type: "move", dir: "south" });
  });
});

describe("mid-choice snapshots and determinism", () => {
  const interactions = [
    {
      commands: [
        choice("Save here?", [
          { label: "Yes", commands: [say("Saved."), { type: "set_flag", flag: "chose" }] },
          { label: "No", commands: [say("Not saved.")] },
        ]),
        say("Onward."),
      ],
    },
  ];

  it("round-trips pendingChoice (options + continuations) through JSON", () => {
    const game = load(fixture(interactions));
    const sim = new Sim(game, 7);
    sim.act({ type: "interact" });
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    const restored = Sim.fromSnapshot(game, snap);
    expect(restored.state.pendingChoice).toEqual(sim.state.pendingChoice);
    const events = restored.act({ type: "choose", index: 0 });
    expect(events).toContain('Wife: "Saved."');
    expect(events).toContain('Wife: "Onward."');
    expect(restored.state.flags).toContain("chose");
    expect(restored.state.pendingChoice).toBeNull();
  });

  it("round-trips through the save-file codec mid-choice", () => {
    const game = load(fixture(interactions));
    const sim = new Sim(game, 7);
    sim.act({ type: "interact" });
    const file = JSON.parse(JSON.stringify(makeSaveFile(sim)));
    const { sim: restored, warnings } = loadSaveFile(game, file);
    expect(warnings).toEqual([]);
    expect(restored.state.pendingChoice).toEqual(sim.state.pendingChoice);
    expect(restored.act({ type: "choose", index: 1 })).toContain('Wife: "Not saved."');
  });

  it("tolerates pre-choice snapshots (pendingChoice defaults to null)", () => {
    const game = load(fixture(interactions));
    const sim = new Sim(game, 7);
    const snap = sim.snapshot() as unknown as Record<string, unknown>;
    delete snap.pendingChoice;
    const restored = Sim.fromSnapshot(game, snap as never);
    expect(restored.state.pendingChoice).toBeNull();
  });

  it("replays deterministically through a choice", () => {
    const game = load(fixture(interactions));
    const run = () => {
      const sim = new Sim(game, 42);
      sim.act({ type: "interact" });
      sim.act({ type: "choose", index: 0 });
      sim.act({ type: "interact" });
      return sim.state;
    };
    expect(run()).toEqual(run());
  });
});

describe("validation", () => {
  it("recurses into options: bad item ref caught with a full path", () => {
    const r = validateGame(
      fixture([
        {
          commands: [
            say("hi"),
            choice("Pick.", [
              { label: "a", commands: [say("ok")] },
              { label: "b", commands: [say("ok")] },
              {
                label: "c",
                commands: [{ type: "give_item", itemId: "no-such-item", qty: 1 }],
              },
            ]),
          ],
        },
      ]),
    );
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) =>
        e.startsWith(
          "maps.main.entities.wife.interactions[0].commands[1].options[2].commands[0]: itemId \"no-such-item\"",
        ),
      ),
    ).toBe(true);
  });

  it("catches errors in nested choices and enforces win-last inside options", () => {
    const r = validateGame(
      fixture([
        {
          commands: [
            choice("Outer.", [
              {
                label: "in",
                commands: [
                  choice("Inner.", [
                    {
                      label: "deep",
                      commands: [
                        { type: "win", text: "done" },
                        say("never runs"),
                      ],
                    },
                  ]),
                ],
              },
            ]),
          ],
        },
      ]),
    );
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) =>
        e.startsWith(
          "maps.main.entities.wife.interactions[0].commands[0].options[0].commands[0].options[0].commands",
        ) && e.includes('"win" must be the last command'),
      ),
    ).toBe(true);
  });

  it("warns when every option is when-gated (possible empty choice)", () => {
    const r = validateGame(
      fixture([
        {
          commands: [
            { type: "set_flag", flag: "a" },
            choice("Gated.", [
              { label: "x", when: { flag: "a" }, commands: [say("x")] },
              { label: "y", when: { notFlag: "a" }, commands: [say("y")] },
            ]),
          ],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(
      r.warnings.some((w) => w.includes("every option of this choice is when-gated")),
    ).toBe(true);
    // An ungated option silences the warning.
    const ok = validateGame(
      fixture([
        {
          commands: [
            { type: "set_flag", flag: "a" },
            choice("Gated.", [
              { label: "x", when: { flag: "a" }, commands: [say("x")] },
              { label: "y", commands: [say("y")] },
            ]),
          ],
        },
      ]),
    );
    expect(ok.warnings).toEqual([]);
  });

  it("flags/vars written inside options count as writes (no false warnings)", () => {
    const r = validateGame(
      fixture([
        {
          when: { all: [{ flag: "vowed" }, { var: "faith", op: "gte", value: 1 }] },
          commands: [say("You vowed.")],
        },
        {
          commands: [
            choice("Vow?", [
              {
                label: "Vow",
                commands: [
                  { type: "set_flag", flag: "vowed" },
                  { type: "add_var", var: "faith", amount: 1 },
                ],
              },
              { label: "Not yet", commands: [say("Later.")] },
            ]),
          ],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("rejects a choice inside trainer rewardCommands (battle-side)", () => {
    const raw = fixture([{ commands: [say("gg")] }]) as {
      maps: { main: { entities: { trainer?: unknown }[] } };
    };
    raw.maps.main.entities[0].trainer = {
      party: [{ speciesId: "critter", level: 3 }],
      defeatFlag: "wife_beaten",
      rewardCommands: [
        choice("A prize?", [{ label: "yes", commands: [say("here")] }]),
      ],
    };
    const r = validateGame(raw);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some(
        (e) =>
          e.includes("trainer.rewardCommands[0]") &&
          e.includes('"choice" can\'t run from a battle'),
      ),
    ).toBe(true);
  });

  it("rejects zero options and works catalog-free", () => {
    const empty = validateGame(fixture([{ commands: [choice("Pick.", [])] }]));
    expect(empty.ok).toBe(false);
    const narrative = validateGame(
      fixture(
        [
          {
            commands: [
              choice("Pick.", [{ label: "only", commands: [say("ok")] }]),
            ],
          },
        ],
        { catalog: false },
      ),
    );
    expect(narrative.ok).toBe(true);
    expect(narrative.warnings).toEqual([]);
  });
});

describe("forge reference walk", () => {
  it("removeItem sees an item referenced inside a choice option", () => {
    const doc = fixture([
      {
        commands: [
          choice("Take?", [
            {
              label: "Take",
              commands: [{ type: "give_item", itemId: "tonic", qty: 1 }],
            },
          ]),
        ],
      },
    ]);
    const result = removeItem(doc, { itemId: "tonic" });
    expect(result.ok).toBe(false);
    expect(
      result.opErrors.some((e) =>
        e.includes("interactions[0].commands[0].options[0].commands[0]"),
      ),
    ).toBe(true);
  });
});

describe("choice as Command type", () => {
  it("nested command lists are typed (compile-time check)", () => {
    const cmd: Command = {
      type: "choice",
      prompt: "p",
      options: [
        {
          label: "l",
          commands: [
            { type: "say", text: "s" },
            { type: "choice", prompt: "inner", options: [{ label: "x", commands: [{ type: "win", text: "w" }] }] },
          ],
        },
      ],
    };
    expect(cmd.type).toBe("choice");
  });
});
