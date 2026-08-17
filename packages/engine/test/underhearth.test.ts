import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sim, parseAction, validateGame, createCombatant, type Game } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function loadGame(): Game {
  const result = validateGame(JSON.parse(readFileSync(join(ROOT, "games/emberwood/game.json"), "utf8")));
  expect(result.errors).toEqual([]);
  return result.game!;
}

const game = loadGame();

/**
 * A sim standing in the Underhearth with a party a player could plausibly
 * arrive with. The region is post-Vespera, so a fresh run would have to grind
 * the veins to get here; that grind is the player's problem, not this test's.
 */
function underhearth(map: string, x: number, y: number, levels = 27): Sim {
  const sim = new Sim(game, 1);
  sim.state.map = map;
  sim.state.playerX = x;
  sim.state.playerY = y;
  sim.state.flags = ["hearth_relit", "vespera_stilled"];
  sim.state.party = ["pyrewyrm", "torrentide", "boulderon"].map((id) =>
    createCombatant(game.catalog!, id, levels),
  );
  return sim;
}

function walk(sim: Sim, dirs: string): void {
  for (const d of dirs.split(/\s+/).filter(Boolean)) sim.act(parseAction(d)!);
}

/** Attack until the battle resolves; the party is strong enough to just swing. */
function fight(sim: Sim, limit = 300): void {
  for (let i = 0; i < limit && sim.state.battle; i++) {
    const b = sim.state.battle;
    if (b.needsSwitch || b.player.party[b.player.active].hp <= 0) {
      const next = b.player.party.findIndex((c) => c.hp > 0);
      if (next < 0) return;
      sim.act(parseAction(`switch${next + 1}`)!);
      continue;
    }
    sim.act(parseAction("move2")!);
  }
}

describe("the Underhearth", () => {
  it("is three connected maps hanging off the summit", () => {
    for (const id of ["hearth-mouth", "ember-veins", "first-hearth"]) {
      expect(game.maps[id], `${id} exists`).toBeDefined();
    }
    // Every portal must land somewhere walkable and NOT on another portal —
    // landing on one bounces the player straight back through it.
    for (const [id, map] of Object.entries(game.maps)) {
      for (const p of map.portals) {
        const dest = game.maps[p.toMap];
        expect(game.legend[dest.rows[p.toY][p.toX]].walkable, `${id} -> ${p.toMap}`).toBe(true);
        const ontoPortal = dest.portals.some((q) => q.x === p.toX && q.y === p.toY);
        expect(ontoPortal, `${id} -> ${p.toMap} lands on a portal`).toBe(false);
      }
    }
  });

  it("is sealed until the Great Hearth is relit", () => {
    const sim = new Sim(game, 1);
    sim.state.map = "ashen-peak";
    sim.state.playerX = 10;
    sim.state.playerY = 2;
    sim.state.flags = ["vespera_stilled"]; // beat her, but the hearth is still cold
    walk(sim, "east east");
    expect(sim.state.map).toBe("ashen-peak");
    expect(sim.state.lastEvents.join(" ")).toContain("Cooled slag");
  });

  it("Everember ends the game, and only from the far chamber", () => {
    const sim = underhearth("first-hearth", 6, 6);
    // East first: west from the entry is the exit portal back to the veins.
    walk(sim, "east east east east north north north north north west west west west");
    expect([sim.state.playerX, sim.state.playerY]).toEqual([6, 1]);

    sim.act(parseAction("interact")!);
    expect(sim.state.battle).not.toBeNull();
    fight(sim);

    expect(sim.state.won).toBe(true);
    expect(sim.state.ending?.id).toBe("victory");
    expect(sim.state.flags).toContain("everember_stilled");
    // The ending is a passage, not a one-liner.
    expect(sim.state.lastPassages[0]?.lines.join(" ")).toContain("alone under the mountain");
  });

  it("hands out its own kindred, none of which existed before", () => {
    const ids = game.catalog!.species.map((s) => s.id);
    for (const id of ["cindercoil", "emberclaw", "hollowpuff", "everember"]) {
      expect(ids).toContain(id);
    }
    // Hollowpuff gives `dark` a second inhabitant, so the type is not a
    // one-creature curiosity.
    const dark = game.catalog!.species.filter((s) => s.types.includes("dark"));
    expect(dark.length).toBeGreaterThanOrEqual(3);
  });

  it("gates Maren's reward on a full party, using the built-in `party` var", () => {
    const sim = new Sim(game, 1);
    sim.state.map = "kiln-interior";
    sim.state.playerX = 4;
    sim.state.playerY = 5; // beside Maren, who stands at (4,4)

    const five = ["emberling", "puddlit", "sproutle", "fuzzle", "gustwing"];
    sim.state.party = five.map((id) => createCombatant(game.catalog!, id, 10));
    sim.act(parseAction("interact")!);
    expect(sim.state.flags).not.toContain("maren_full_party");

    sim.state.party.push(createCombatant(game.catalog!, "voltpup", 10));
    sim.act(parseAction("interact")!);
    expect(sim.state.flags).toContain("maren_full_party");
    expect(sim.state.money).toBeGreaterThan(1000);
  });
});
