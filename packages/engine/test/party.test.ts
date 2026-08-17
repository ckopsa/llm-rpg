import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Sim, parseAction, validateGame, observe } from "../src/index.js";
import { createCombatant } from "../src/battle.js";
import type { Game } from "../src/index.js";

const emberwoodPath = fileURLToPath(
  new URL("../../../games/emberwood/game.json", import.meta.url),
);

function loadGame(): Game {
  const result = validateGame(JSON.parse(readFileSync(emberwoodPath, "utf8")));
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

const game = loadGame();

/** A sim parked on the Mosshollow patch with a chosen party. */
function inPasture(party: string[], seed = 5): Sim {
  const sim = new Sim(game, seed);
  sim.state.map = "mosshollow";
  sim.state.playerX = 2;
  sim.state.playerY = 8;
  sim.state.party = party.map((id) => createCombatant(game.catalog!, id, 15));
  return sim;
}

/** Walk on and off the tall grass until something engages. */
function untilBattle(sim: Sim, limit = 60): void {
  for (let i = 0; i < limit && !sim.state.battle; i++) {
    sim.act(parseAction(i % 2 ? "north" : "south")!);
  }
}

describe("party reordering", () => {
  it("lead2 promotes slot 2 and the change persists into the next battle", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    expect(sim.state.party.map((c) => c.speciesId)).toEqual(["flufflehup", "woxeley"]);

    const events = sim.act(parseAction("lead2")!);
    expect(events.join(" ")).toContain("Woxeley moves to the front");
    expect(sim.state.party.map((c) => c.speciesId)).toEqual(["woxeley", "flufflehup"]);

    // The point of the feature: the NEW order is what walks into the fight.
    untilBattle(sim);
    const active = sim.state.battle!.player;
    expect(active.party[active.active].speciesId).toBe("woxeley");
  });

  it("an in-battle switch does NOT reorder the party", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    untilBattle(sim);
    sim.act(parseAction("switch2")!);
    expect(sim.state.party.map((c) => c.speciesId)).toEqual(["flufflehup", "woxeley"]);
  });

  it("rejects an empty slot, naming the valid range", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    const events = sim.act(parseAction("lead5")!);
    expect(events.join(" ")).toContain("lead1..lead2");
    expect(sim.state.party.map((c) => c.speciesId)).toEqual(["flufflehup", "woxeley"]);
  });

  it("says so when the creature already leads", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    expect(sim.act(parseAction("lead1")!).join(" ")).toContain("already leading");
  });

  it("is rejected during a battle, which has its own switch", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    untilBattle(sim);
    const events = sim.act(parseAction("lead2")!);
    expect(events.join(" ")).toContain("You are in a battle");
    expect(sim.state.party.map((c) => c.speciesId)).toEqual(["flufflehup", "woxeley"]);
  });

  it("ticks no `turn` triggers — sorting your pockets is not a world beat", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    const before = sim.state.firedTriggers.length;
    sim.act(parseAction("lead2")!);
    expect(sim.state.firedTriggers.length).toBe(before);
  });

  it("advertises itself in the action list only when there is something to reorder", () => {
    expect(observe(inPasture(["flufflehup", "woxeley"]))).toContain("lead2..lead2");
    expect(observe(inPasture(["flufflehup"]))).not.toContain("lead");
  });
});

describe("battles open with a creature that can fight", () => {
  it("skips a fainted lead instead of starting the fight already down", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    sim.state.party[0].hp = 0;
    untilBattle(sim);

    const side = sim.state.battle!.player;
    expect(side.party[side.active].speciesId).toBe("woxeley");
    expect(side.party[side.active].hp).toBeGreaterThan(0);
  });

  it("still refuses the grass when every kindred has fainted", () => {
    const sim = inPasture(["flufflehup", "woxeley"]);
    for (const c of sim.state.party) c.hp = 0;
    const events = sim.act(parseAction("south")!);
    expect(events.join(" ")).toContain("too weary");
    expect(sim.state.battle).toBeNull();
  });
});
