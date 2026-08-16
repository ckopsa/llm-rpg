import { describe, expect, it } from "vitest";
import { Sim, observe, validateGame, type Game } from "../src/index.js";

/**
 * djt.3 (triggers) — map-level `enter` and `step` triggers: the firing matrix
 * (game start, portal arrival, teleport arrival, step-on, once vs repeat,
 * when-gated), choice-inside-trigger, the queue-after ordering rule for
 * triggers firing mid-continuation, narrator attribution, snapshot safety,
 * and validation (unique ids, step tiles, command recursion).
 */

interface RawMap {
  rows: string[];
  entities?: unknown[];
  portals?: unknown[];
  triggers?: unknown[];
}

/**
 * Two rooms joined by a portal:
 *   west (5x3): player at (1,1), portal at (3,1) -> east (1,1)
 *   east (5x3): portal back at (3,1) -> west (1,1)
 */
function fixture(opts: {
  west?: Partial<RawMap>;
  east?: Partial<RawMap>;
}): unknown {
  return {
    meta: { id: "trigger-test", title: "Trigger Test", goal: "test triggers" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      west: {
        rows: ["#####", "#...#", "#####"],
        portals: [{ x: 3, y: 1, toMap: "east", toX: 1, toY: 1 }],
        ...opts.west,
      },
      east: {
        rows: ["#####", "#...#", "#####"],
        portals: [{ x: 3, y: 1, toMap: "west", toX: 1, toY: 1 }],
        ...opts.east,
      },
    },
    player: { glyph: "@", map: "west", x: 1, y: 1 },
  };
}

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

const say = (text: string): unknown => ({ type: "say", text });

describe("enter triggers", () => {
  it("game start counts as arriving on the start map", () => {
    const sim = new Sim(
      load(
        fixture({
          west: {
            triggers: [
              {
                id: "welcome",
                on: "enter",
                commands: [say("A cold morning."), { type: "set_flag", flag: "woke" }],
              },
            ],
          },
        }),
      ),
      1,
    );
    // Fired before the first act: narrator say prints bare (no speaker).
    expect(sim.state.lastEvents).toContain("A cold morning.");
    expect(sim.state.flags).toContain("woke");
    expect(sim.state.firedTriggers).toEqual(["west:welcome"]);
    expect(sim.state.turn).toBe(0);
  });

  it("fires on portal arrival, once by default, and per-arrival with once:false", () => {
    const game = load(
      fixture({
        east: {
          triggers: [
            { id: "once-t", on: "enter", commands: [say("First arrival.")] },
            { id: "every-t", on: "enter", once: false, commands: [say("The east wind blows.")] },
          ],
        },
      }),
    );
    const sim = new Sim(game, 1);
    expect(sim.state.firedTriggers).toEqual([]); // start map has no triggers
    sim.act({ type: "move", dir: "east" });
    const events = sim.act({ type: "move", dir: "east" }); // onto the portal
    expect(sim.state.map).toBe("east");
    expect(events).toContain("First arrival.");
    expect(events).toContain("The east wind blows.");
    // Definition order preserved.
    expect(events.indexOf("First arrival.")).toBeLessThan(
      events.indexOf("The east wind blows."),
    );
    // Round trip: back west, then east again.
    sim.act({ type: "move", dir: "east" });
    sim.act({ type: "move", dir: "east" }); // portal back to west
    expect(sim.state.map).toBe("west");
    sim.act({ type: "move", dir: "east" });
    const again = sim.act({ type: "move", dir: "east" });
    expect(again).not.toContain("First arrival.");
    expect(again).toContain("The east wind blows.");
    expect(sim.state.firedTriggers).toEqual(["east:once-t"]);
  });

  it("teleport_player fires the target map's enter triggers", () => {
    const game = load(
      fixture({
        west: {
          entities: [
            {
              id: "seer", name: "Seer", glyph: "S", x: 2, y: 1, blocking: false,
              interactions: [
                { commands: [{ type: "teleport_player", mapId: "east", x: 1, y: 1 }] },
              ],
            },
          ],
        },
        east: {
          triggers: [{ id: "arrive", on: "enter", commands: [say("You have crossed over.")] }],
        },
      }),
    );
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });
    expect(events).toContain("You find yourself in east.");
    expect(events).toContain("You have crossed over.");
    expect(sim.state.map).toBe("east");
    expect(sim.state.firedTriggers).toEqual(["east:arrive"]);
  });
});

describe("step triggers", () => {
  const stepFixture = (trigger: Record<string, unknown>) =>
    fixture({
      west: {
        triggers: [
          {
            id: "plate",
            on: "step",
            tiles: [{ x: 2, y: 1 }],
            commands: [say("The floor clicks.")],
            ...trigger,
          },
        ],
      },
    });

  it("fires when the player lands on a listed tile, not on others", () => {
    const sim = new Sim(load(stepFixture({})), 1);
    expect(sim.state.lastEvents).toEqual([]); // not fired at game start
    const events = sim.act({ type: "move", dir: "east" }); // to (2,1)
    expect(events).toContain("The floor clicks.");
    expect(sim.state.firedTriggers).toEqual(["west:plate"]);
  });

  it("once (default) vs once:false on repeated landings", () => {
    const once = new Sim(load(stepFixture({})), 1);
    once.act({ type: "move", dir: "east" });
    once.act({ type: "move", dir: "west" });
    expect(once.act({ type: "move", dir: "east" })).not.toContain("The floor clicks.");

    const every = new Sim(load(stepFixture({ once: false })), 1);
    every.act({ type: "move", dir: "east" });
    every.act({ type: "move", dir: "west" });
    expect(every.act({ type: "move", dir: "east" })).toContain("The floor clicks.");
    expect(every.state.firedTriggers).toEqual([]);
  });

  it("a failing when-gate skips WITHOUT marking fired; it can fire later", () => {
    const raw = fixture({
      west: {
        rows: ["######", "#....#", "######"],
        portals: [],
        entities: [
          {
            id: "lever", name: "Lever", glyph: "L", x: 2, y: 1, blocking: false,
            interactions: [{ commands: [{ type: "set_flag", flag: "armed" }] }],
          },
        ],
        triggers: [
          {
            id: "trap",
            on: "step",
            tiles: [{ x: 3, y: 1 }],
            when: { flag: "armed" },
            commands: [say("Snap!")],
          },
        ],
      },
    });
    const game = load(raw);
    const sim = new Sim(game, 1);
    sim.act({ type: "move", dir: "east" }); // onto the lever tile (non-blocking)
    sim.act({ type: "move", dir: "east" }); // onto the trap tile — gate fails
    expect(sim.state.lastEvents).not.toContain("Snap!");
    expect(sim.state.firedTriggers).toEqual([]);
    sim.act({ type: "move", dir: "west" });
    sim.act({ type: "move", dir: "west" }); // back to (1,1), lever adjacent east
    sim.act({ type: "interact" }); // pull the lever
    expect(sim.state.flags).toContain("armed");
    sim.act({ type: "move", dir: "east" });
    const events = sim.act({ type: "move", dir: "east" });
    expect(events).toContain("Snap!");
    expect(sim.state.firedTriggers).toEqual(["west:trap"]);
  });

  it("portal arrival on a listed tile fires the destination step trigger", () => {
    const game = load(
      fixture({
        east: {
          triggers: [
            {
              id: "landing",
              on: "step",
              tiles: [{ x: 1, y: 1 }], // the portal destination
              commands: [say("You land hard.")],
            },
          ],
        },
      }),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "move", dir: "east" });
    const events = sim.act({ type: "move", dir: "east" }); // portal -> east (1,1)
    expect(events).toContain("You land hard.");
  });
});

describe("choices inside triggers", () => {
  const choiceTrigger = fixture({
    west: {
      triggers: [
        {
          id: "voice",
          on: "step",
          tiles: [{ x: 2, y: 1 }],
          commands: [
            say("A voice speaks."),
            {
              type: "choice",
              prompt: "Answer it?",
              options: [
                { label: "Yes", commands: [say("It hears you."), { type: "set_flag", flag: "answered" }] },
                { label: "No", commands: [say("Silence.")] },
              ],
            },
            say("The air settles."),
          ],
        },
      ],
    },
  });

  it("suspends like any interaction; choosing resumes the trigger epilogue", () => {
    const sim = new Sim(load(choiceTrigger), 1);
    const events = sim.act({ type: "move", dir: "east" });
    expect(events).toContain("A voice speaks.");
    expect(events).toContain("Answer it?");
    expect(events.some((e) => e.includes("The air settles."))).toBe(false);
    expect(sim.state.pendingChoice).not.toBeNull();
    expect(sim.state.pendingChoice!.sourceId).toBe("trigger:west:voice");
    expect(observe(sim)).toContain("Actions: choose1..choose2");
    const chosen = sim.act({ type: "choose", index: 0 });
    // Narrator lines print bare, and the epilogue resumes after the option.
    expect(chosen.indexOf("It hears you.")).toBeGreaterThan(-1);
    expect(chosen.indexOf("The air settles.")).toBeGreaterThan(chosen.indexOf("It hears you."));
    expect(sim.state.flags).toContain("answered");
  });

  it("mid-choice snapshots restore and resume (trigger-sourced too)", () => {
    const game = load(choiceTrigger);
    const sim = new Sim(game, 3);
    sim.act({ type: "move", dir: "east" });
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    const restored = Sim.fromSnapshot(game, snap);
    expect(restored.state.pendingChoice).toEqual(sim.state.pendingChoice);
    const events = restored.act({ type: "choose", index: 1 });
    expect(events).toContain("Silence.");
    expect(events).toContain("The air settles.");
    expect(restored.state.firedTriggers).toEqual(["west:voice"]);
  });

  it("a game-start trigger can open on a choice", () => {
    const game = load(
      fixture({
        west: {
          triggers: [
            {
              id: "prologue",
              on: "enter",
              commands: [
                {
                  type: "choice",
                  prompt: "Begin?",
                  options: [{ label: "Begin", commands: [say("So it begins.")] }],
                },
              ],
            },
          ],
        },
      }),
    );
    const sim = new Sim(game, 1);
    expect(sim.state.pendingChoice).not.toBeNull();
    expect(sim.state.lastEvents).toContain("Begin?");
    const events = sim.act({ type: "choose", index: 0 });
    expect(events).toContain("So it begins.");
  });
});

describe("trigger firing mid-continuation queues AFTER pending commands", () => {
  it("teleport inside a command list: the enter trigger runs after the list", () => {
    const game = load(
      fixture({
        west: {
          entities: [
            {
              id: "seer", name: "Seer", glyph: "S", x: 2, y: 1, blocking: false,
              interactions: [
                {
                  commands: [
                    say("Go now."),
                    { type: "teleport_player", mapId: "east", x: 1, y: 1 },
                    say("...and don't look back."),
                  ],
                },
              ],
            },
          ],
        },
        east: {
          triggers: [{ id: "arrive", on: "enter", commands: [say("The east receives you.")] }],
        },
      }),
    );
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });
    const order = [
      events.indexOf('Seer: "Go now."'),
      events.indexOf("You find yourself in east."),
      events.indexOf('Seer: "...and don\'t look back."'),
      events.indexOf("The east receives you."),
    ];
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]); // list finishes first
    expect(order[3]).toBeGreaterThan(order[2]); // trigger queued after
  });

  it("teleport inside a chosen option: the trigger runs after the choice epilogue", () => {
    const game = load(
      fixture({
        west: {
          entities: [
            {
              id: "seer", name: "Seer", glyph: "S", x: 2, y: 1, blocking: false,
              interactions: [
                {
                  commands: [
                    {
                      type: "choice",
                      prompt: "Cross?",
                      options: [
                        {
                          label: "Cross",
                          commands: [{ type: "teleport_player", mapId: "east", x: 1, y: 1 }],
                        },
                      ],
                    },
                    say("May it go well."),
                  ],
                },
              ],
            },
          ],
        },
        east: {
          triggers: [{ id: "arrive", on: "enter", commands: [say("The east receives you.")] }],
        },
      }),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    const events = sim.act({ type: "choose", index: 0 });
    const teleportIdx = events.indexOf("You find yourself in east.");
    const epilogueIdx = events.indexOf('Seer: "May it go well."');
    const triggerIdx = events.indexOf("The east receives you.");
    expect(teleportIdx).toBeGreaterThan(-1);
    expect(epilogueIdx).toBeGreaterThan(teleportIdx); // continuation resumes first
    expect(triggerIdx).toBeGreaterThan(epilogueIdx); // then the queued trigger
  });
});

describe("trigger validation", () => {
  it("requires unique ids per map and tiles on step triggers, forbids tiles on enter", () => {
    const r = validateGame(
      fixture({
        west: {
          triggers: [
            { id: "t", on: "enter", commands: [say("a")] },
            { id: "t", on: "step", commands: [say("b")] },
            { id: "u", on: "enter", tiles: [{ x: 1, y: 1 }], commands: [say("c")] },
            { id: "v", on: "step", tiles: [{ x: 9, y: 9 }], commands: [say("d")] },
            { id: "w", on: "step", tiles: [{ x: 0, y: 0 }], commands: [say("e")] },
          ],
        },
      }),
    );
    expect(r.ok).toBe(false);
    const text = r.errors.join("\n");
    expect(text).toContain('duplicate trigger id "t"');
    expect(text).toContain('a "step" trigger needs "tiles"');
    expect(text).toContain('"tiles" only applies to "step" triggers');
    expect(text).toContain("maps.west.triggers[3].tiles[0]: (9, 9) is outside");
    // Non-walkable step tile is a warning, not an error.
    expect(r.warnings.some((w) => w.includes("triggers[4].tiles[0]") && w.includes("non-walkable"))).toBe(true);
  });

  it("recurses trigger commands through all cross-checks with full paths", () => {
    const r = validateGame(
      fixture({
        west: {
          triggers: [
            {
              id: "bad",
              on: "enter",
              commands: [{ type: "give_item", itemId: "relic", qty: 1 }],
            },
          ],
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.startsWith("maps.west.triggers[0].commands[0]:") && e.includes("give_item")),
    ).toBe(true);
  });

  it("flags written by trigger commands count as writes (no false warnings)", () => {
    const r = validateGame(
      fixture({
        west: {
          entities: [
            {
              id: "door", name: "Door", glyph: "D", x: 2, y: 1,
              passableWithFlag: "opened",
              interactions: [{ commands: [say("Locked.")] }],
            },
          ],
          triggers: [
            { id: "open", on: "enter", commands: [{ type: "set_flag", flag: "opened" }] },
          ],
        },
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("trigger snapshot safety", () => {
  it("firedTriggers round-trips; a restored save never re-fires game-start triggers", () => {
    const game = load(
      fixture({
        west: {
          triggers: [
            { id: "welcome", on: "enter", commands: [{ type: "add_var", var: "greetings", amount: 1 }] },
          ],
        },
      }),
    );
    const sim = new Sim(game, 1);
    expect(sim.state.vars.greetings).toBe(1);
    const restored = Sim.fromSnapshot(game, JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.state.vars.greetings).toBe(1); // not 2 — no re-fire
    expect(restored.state.firedTriggers).toEqual(["west:welcome"]);
    expect(restored.state).toEqual(sim.state);
  });
});
