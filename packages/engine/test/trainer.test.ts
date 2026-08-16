import { describe, expect, it } from "vitest";
import { Sim, observe, parseAction, validateGame } from "../src/index.js";
import type { Game } from "../src/index.js";

/**
 * Trainer NPCs: interact-triggered and line-of-sight battles, mode "trainer"
 * restrictions (no run, no catch), victory rewards, and post-defeat behavior.
 */

const catalog = {
  typeChart: { types: ["normal"], effectiveness: {} },
  moves: [
    { id: "tackle", name: "Tackle", type: "normal", category: "physical", power: 50, accuracy: 1, pp: 30 },
    { id: "smash", name: "Smash", type: "normal", category: "physical", power: 100, accuracy: 1, pp: 20 },
    { id: "poke", name: "Poke", type: "normal", category: "physical", power: 10, accuracy: 1, pp: 30 },
  ],
  species: [
    { id: "champ", name: "Champ", glyph: "🐯", types: ["normal"],
      baseStats: { hp: 80, atk: 90, def: 80, spd: 99 },
      learnset: [{ level: 1, moveId: "smash" }],
      catchRate: 0.5, xpYield: 60 },
    { id: "critter", name: "Critter", glyph: "🐛", types: ["normal"],
      baseStats: { hp: 30, atk: 20, def: 20, spd: 10 },
      learnset: [{ level: 1, moveId: "poke" }],
      catchRate: 0.5, xpYield: 300 },
  ],
  items: [
    { id: "salve", name: "Salve", kind: "heal", amount: 20 },
    { id: "snare", name: "Snare", kind: "capture", ballMod: 1 },
  ],
};

interface FixtureOpts {
  rows?: string[];
  party?: { speciesId: string; level: number }[];
  inventory?: { itemId: string; qty: number }[];
  money?: number;
  /** Merged over the default trainer block (use undefined values to drop keys). */
  trainer?: Record<string, unknown>;
  interactions?: unknown[];
  extraEntities?: unknown[];
}

/** Ranger Rex at (6,1) watches west down row 1 (range 3: tiles x 3..5).
 *  The player starts at (1,1); row 2 is a safe corridor out of sight. */
function fixture(opts: FixtureOpts = {}): unknown {
  const trainer = {
    party: [{ speciesId: "critter", level: 3 }],
    defeatFlag: "rex_beaten",
    lineOfSight: { dir: "west", range: 3 },
    rewardMoney: 25,
    rewardCommands: [{ type: "give_item", itemId: "snare", qty: 1 }],
    intro: "You there! Let's battle.",
    defeatText: "You've got the knack.",
    outro: "Fine morning for a walk.",
    ...(opts.trainer ?? {}),
  };
  return {
    meta: { id: "trainer-test", title: "Trainer Test", goal: "beat Ranger Rex" },
    catalog: structuredClone(catalog),
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: opts.rows ?? ["#########", "#.......#", "#.......#", "#########"],
        entities: [
          {
            id: "rex", name: "Ranger Rex", glyph: "R", x: 6, y: 1,
            trainer,
            interactions: opts.interactions ?? [],
          },
          ...(opts.extraEntities ?? []),
        ],
      },
    },
    player: {
      glyph: "@", map: "main", x: 1, y: 1,
      party: opts.party ?? [{ speciesId: "champ", level: 10 }],
      inventory: opts.inventory ?? [],
      money: opts.money ?? 0,
      respawn: { map: "main", x: 1, y: 1 },
    },
  };
}

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

function play(sim: Sim, script: string): string[] {
  const events: string[] = [];
  for (const word of script.split(/[,\s]+/).filter(Boolean)) {
    const action = parseAction(word);
    if (!action) throw new Error(`bad action in script: ${word}`);
    events.push(...sim.act(action));
  }
  return events;
}

function fightOut(sim: Sim, maxRounds = 30): string[] {
  const events: string[] = [];
  for (let i = 0; i < maxRounds && sim.state.battle; i++) {
    events.push(...sim.act({ type: "battle_move", index: 0 }));
  }
  return events;
}

describe("trainer validation", () => {
  it("rejects a trainer party species missing from the catalog", () => {
    const result = validateGame(fixture({ trainer: { party: [{ speciesId: "ghost", level: 3 }] } }));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'maps.main.entities.rex.trainer.party[0]: speciesId "ghost" is not in the catalog',
    );
  });

  it("rejects a line-of-sight range below 1", () => {
    const result = validateGame(
      fixture({ trainer: { lineOfSight: { dir: "west", range: 0 } } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("range must be at least 1");
  });

  it("rejects rewardCommands referencing unknown items", () => {
    const result = validateGame(
      fixture({ trainer: { rewardCommands: [{ type: "give_item", itemId: "nope", qty: 1 }] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'maps.main.entities.rex.trainer.rewardCommands[0]: itemId "nope" is not in the catalog',
    );
  });

  it("rejects an empty trainer party", () => {
    const result = validateGame(fixture({ trainer: { party: [] } }));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("trainer.party");
  });
});

describe("trainer engagement", () => {
  it("interacting with an undefeated trainer starts a trainer battle", () => {
    const sim = new Sim(load(fixture({ trainer: { lineOfSight: undefined } })));
    const walk = play(sim, "east east east east");
    expect(walk.join("\n")).not.toContain("challenges you");
    expect(sim.state.playerX).toBe(5); // next to Rex, who blocks movement
    const events = play(sim, "interact");
    const text = events.join("\n");
    expect(text).toContain('Ranger Rex: "You there! Let\'s battle."');
    expect(text).toContain("Ranger Rex challenges you to battle!");
    expect(sim.state.battle).not.toBeNull();
    expect(sim.state.battle!.mode).toBe("trainer");
    expect(sim.state.battleTrainer).toBe("rex");
  });

  it("line of sight triggers the battle automatically at range", () => {
    const sim = new Sim(load(fixture()));
    const first = play(sim, "east"); // (2,1): 4 tiles away, out of range 3
    expect(first.join("\n")).not.toContain("spots you");
    expect(sim.state.battle).toBeNull();
    const events = play(sim, "east"); // (3,1): exactly range 3, clear line
    const text = events.join("\n");
    expect(text).toContain("Ranger Rex spots you!");
    expect(text).toContain('Ranger Rex: "You there! Let\'s battle."');
    expect(sim.state.battle).not.toBeNull();
    expect(sim.state.battle!.mode).toBe("trainer");
    expect(sim.state.playerX).toBe(3);
  });

  it("does not trigger off the sight axis", () => {
    const sim = new Sim(load(fixture()));
    play(sim, "south east east east east"); // row 2, right under the watched tiles
    expect(sim.state.battle).toBeNull();
    expect(sim.state.playerX).toBe(5);
  });

  it("a wall between blocks the sight line", () => {
    const sim = new Sim(
      load(fixture({ rows: ["#########", "#...#...#", "#.......#", "#########"] })),
    );
    play(sim, "east east"); // (3,1): Rex's line crosses the wall at (4,1)
    expect(sim.state.battle).toBeNull();
    expect(sim.state.playerX).toBe(3);
  });

  it("a blocking entity between blocks the sight line", () => {
    const sim = new Sim(
      load(
        fixture({
          extraEntities: [{ id: "rock", name: "Big Rock", glyph: "O", x: 4, y: 1 }],
        }),
      ),
    );
    play(sim, "east east"); // (3,1): the rock at (4,1) shields the player
    expect(sim.state.battle).toBeNull();
  });

  it("does not engage a player with no able kindred, and says why", () => {
    const empty = new Sim(load(fixture({ party: [] })));
    const events = play(empty, "east east");
    expect(events.join("\n")).toContain("No kindred fit to battle");
    expect(empty.state.battle).toBeNull();

    const fainted = new Sim(load(fixture()));
    fainted.state.party[0].hp = 0;
    const events2 = play(fainted, "east east");
    expect(events2.join("\n")).toContain("No kindred fit to battle");
    expect(fainted.state.battle).toBeNull();
  });
});

describe("trainer battles", () => {
  it("forbids run and catch; capture items are not consumed", () => {
    const sim = new Sim(
      load(fixture({ inventory: [{ itemId: "snare", qty: 1 }, { itemId: "salve", qty: 1 }] })),
    );
    play(sim, "east east");
    expect(sim.state.battle).not.toBeNull();

    const run = sim.act({ type: "battle_run" }).join("\n");
    expect(run).toContain("You can't run from a trainer battle!");
    expect(sim.state.battle).not.toBeNull();

    const roundBefore = sim.state.battle!.round;
    const snare = sim.act({ type: "battle_catch" }).join("\n");
    expect(snare).toContain("You can't catch another keeper's kindred!");
    expect(sim.state.battle!.round).toBe(roundBefore);
    expect(sim.state.inventory.find((e) => e.itemId === "snare")!.qty).toBe(1);

    // Using a capture item from the bag is refused too, without consuming it.
    const viaItem = sim.act({ type: "battle_item", index: 0 }).join("\n");
    expect(viaItem).toContain("You can't catch another keeper's kindred!");
    expect(sim.state.inventory.find((e) => e.itemId === "snare")!.qty).toBe(1);

    // The battle observer offers neither catch nor run.
    const text = observe(sim);
    expect(text).toContain("Trainer battle");
    const actionsLine = text.split("\n").find((l) => l.startsWith("Actions:"))!;
    expect(actionsLine).toBe("Actions: move1..move1 | item1..item2");
  });

  it("victory sets the defeat flag, pays out, runs reward commands, says the defeat line", () => {
    const sim = new Sim(load(fixture({ money: 5 })));
    play(sim, "east east");
    const events = fightOut(sim);
    const text = events.join("\n");
    expect(text).toContain("You won the battle!");
    expect(text).toContain("You won 25 coins!");
    expect(text).toContain("You received 1x Snare.");
    expect(text).toContain('Ranger Rex: "You\'ve got the knack."');
    expect(sim.state.flags).toContain("rex_beaten");
    expect(sim.state.money).toBe(30);
    expect(sim.state.inventory).toEqual([{ itemId: "snare", qty: 1 }]);
    expect(sim.state.battle).toBeNull();
    expect(sim.state.battleTrainer).toBeNull();
  });

  it("sends the next enemy after a faint and grants XP per faint", () => {
    const sim = new Sim(
      load(
        fixture({
          trainer: {
            party: [
              { speciesId: "critter", level: 3 },
              { speciesId: "critter", level: 3 },
            ],
          },
        }),
      ),
    );
    play(sim, "east east");
    const text = fightOut(sim).join("\n");
    expect(text).toContain("Enemy Critter was sent out!");
    expect(text.match(/gained \d+ XP/g)).toHaveLength(2);
    expect(text).toContain("You won the battle!");
    expect(sim.state.flags).toContain("rex_beaten");
  });

  it("a defeated trainer chats like a normal NPC (outro fallback)", () => {
    const sim = new Sim(load(fixture()));
    play(sim, "east east");
    fightOut(sim);
    // Sight line no longer triggers.
    const walk = play(sim, "east east");
    expect(walk.join("\n")).not.toContain("spots you");
    expect(sim.state.battle).toBeNull();
    expect(sim.state.playerX).toBe(5);
    const chat = play(sim, "interact");
    expect(chat.join("\n")).toContain('Ranger Rex: "Fine morning for a walk."');
    // The nearby listing drops the trainer tag once defeated.
    expect(observe(sim)).not.toContain("(a trainer, looking for a battle)");
  });

  it("a defeated trainer prefers its interactions list over the outro", () => {
    const sim = new Sim(
      load(
        fixture({
          interactions: [
            { commands: [{ type: "say", "text": "Rematch? Maybe next season." }] },
          ],
        }),
      ),
    );
    play(sim, "east east");
    fightOut(sim);
    play(sim, "east east");
    const chat = play(sim, "interact");
    expect(chat.join("\n")).toContain('Ranger Rex: "Rematch? Maybe next season."');
    expect(chat.join("\n")).not.toContain("Fine morning");
  });

  it("losing to a trainer respawns the player and leaves the trainer undefeated", () => {
    const sim = new Sim(
      load(
        fixture({
          party: [{ speciesId: "critter", level: 2 }],
          money: 50,
          trainer: { party: [{ speciesId: "champ", level: 12 }] },
        }),
      ),
    );
    play(sim, "east east");
    const text = fightOut(sim).join("\n");
    expect(text).toContain("You lost the battle!");
    expect(text).toContain("You wake by the hearth");
    expect(sim.state.battle).toBeNull();
    expect(sim.state.battleTrainer).toBeNull();
    expect(sim.state.playerX).toBe(1);
    expect(sim.state.money).toBe(25);
    expect(sim.state.party[0].hp).toBe(sim.state.party[0].maxHp);
    expect(sim.state.flags).not.toContain("rex_beaten");
    // Walking back into the sight line re-engages.
    play(sim, "east east");
    expect(sim.state.battle).not.toBeNull();
  });

  it("the overworld observation flags an undefeated trainer nearby", () => {
    const sim = new Sim(load(fixture()));
    expect(observe(sim)).toContain("R Ranger Rex — 5 east (a trainer, looking for a battle)");
  });

  it("a replay including a trainer battle is deterministic", () => {
    const run = () => {
      const sim = new Sim(load(fixture()), 5);
      const events = [...play(sim, "east east"), ...fightOut(sim), ...play(sim, "east interact")];
      return { events, snapshot: sim.snapshot() };
    };
    const a = run();
    const b = run();
    expect(a.events.join("\n")).toContain("You won the battle!");
    expect(b.events).toEqual(a.events);
    expect(b.snapshot).toEqual(a.snapshot);
  });
});

describe("demo trainer (Trailhand Ivo)", () => {
  const demoPath = new URL("../../../games/demo/game.json", import.meta.url);

  it("ambushes on the east-road grass row, pays out, then chats", async () => {
    const { readFileSync } = await import("node:fs");
    const demo = JSON.parse(readFileSync(demoPath, "utf8"));
    demo.player.map = "east-road";
    demo.player.x = 1;
    demo.player.y = 3;
    demo.player.party = [{ speciesId: "emberling", level: 8 }];
    demo.maps["east-road"].encounters.rate = 0; // isolate the trainer battle
    const sim = new Sim(load(demo), 5);

    play(sim, "east east east east east east"); // stops at (7,3): range 3 west of Ivo
    expect(sim.state.battle).not.toBeNull();
    expect(sim.state.battle!.mode).toBe("trainer");
    expect(sim.state.lastEvents.join("\n")).toContain(
      'Trailhand Ivo: "Hey! My kindred need the exercise."',
    );

    const moneyBefore = sim.state.money;
    const events: string[] = [];
    for (let i = 0; i < 40 && sim.state.battle; i++) {
      events.push(...sim.act({ type: "battle_move", index: 1 })); // Flame Jet
    }
    const text = events.join("\n");
    expect(text).toContain("You won the battle!");
    expect(text.match(/gained \d+ XP/g)!.length).toBe(2); // one per fainted kindred
    expect(text).toContain("You won 40 coins!");
    expect(text).toContain("You received 1x Warm Snare.");
    expect(sim.state.flags).toContain("ivo_defeated");
    expect(sim.state.money).toBe(moneyBefore + 40);

    // Defeated: walk right up under his nose and chat.
    play(sim, "east east");
    expect(sim.state.battle).toBeNull();
    const chat = play(sim, "interact");
    expect(chat.join("\n")).toContain(
      'Trailhand Ivo: "The grass out here gets livelier every week."',
    );
  });
});
