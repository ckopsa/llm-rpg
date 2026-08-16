import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Sim, parseAction, validateGame, observe, renderGrid } from "../src/index.js";
import type { Game } from "../src/index.js";

const demoPath = fileURLToPath(new URL("../../../games/demo/game.json", import.meta.url));
const demoRaw = JSON.parse(readFileSync(demoPath, "utf8"));

function loadDemo(): Game {
  const result = validateGame(demoRaw);
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

/** Compact test catalog for sim/battle wiring tests (all-normal, no misses). */
const testCatalog = {
  typeChart: { types: ["normal"], effectiveness: {} },
  moves: [
    { id: "tackle", name: "Tackle", type: "normal", category: "physical", power: 50, accuracy: 1, pp: 30 },
    { id: "smash", name: "Smash", type: "normal", category: "physical", power: 100, accuracy: 1, pp: 20 },
    { id: "poke", name: "Poke", type: "normal", category: "physical", power: 10, accuracy: 1, pp: 30 },
    { id: "jab", name: "Jab", type: "normal", category: "physical", power: 15, accuracy: 1, pp: 30 },
    { id: "flick", name: "Flick", type: "normal", category: "physical", power: 20, accuracy: 1, pp: 30 },
  ],
  species: [
    { id: "champ", name: "Champ", glyph: "🐯", types: ["normal"],
      baseStats: { hp: 80, atk: 90, def: 80, spd: 99 },
      learnset: [{ level: 1, moveId: "smash" }],
      catchRate: 0.5, xpYield: 60 },
    { id: "sprout", name: "Sprout", glyph: "🌱", types: ["normal"],
      baseStats: { hp: 40, atk: 40, def: 40, spd: 50 },
      learnset: [{ level: 1, moveId: "tackle" }, { level: 10, moveId: "smash" }],
      evolvesTo: { speciesId: "bloom", level: 10 },
      catchRate: 0.6, xpYield: 64 },
    { id: "bloom", name: "Bloom", glyph: "🌸", types: ["normal"],
      baseStats: { hp: 70, atk: 70, def: 60, spd: 60 },
      learnset: [{ level: 1, moveId: "tackle" }],
      catchRate: 0.3, xpYield: 100 },
    { id: "learner", name: "Learner", glyph: "📚", types: ["normal"],
      baseStats: { hp: 60, atk: 60, def: 60, spd: 60 },
      learnset: [
        { level: 1, moveId: "tackle" },
        { level: 1, moveId: "poke" },
        { level: 1, moveId: "jab" },
        { level: 1, moveId: "flick" },
        { level: 10, moveId: "smash" },
      ],
      catchRate: 0.5, xpYield: 50 },
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

interface WildOpts {
  rate?: number;
  party?: { speciesId: string; level: number }[];
  inventory?: { itemId: string; qty: number }[];
  money?: number;
  enemy?: { speciesId: string; level: number };
  respawn?: { map: string; x: number; y: number };
}

/** Minimal single-map game with a grass strip and a single-species table. */
function wildFixture(opts: WildOpts = {}): unknown {
  const enemy = opts.enemy ?? { speciesId: "critter", level: 5 };
  return {
    meta: { id: "wild-test", title: "Wild Test", goal: "test encounters" },
    catalog: structuredClone(testCatalog),
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
      "*": { name: "grass", glyph: "*", walkable: true, wild: true },
    },
    maps: {
      main: {
        rows: ["#########", "#.******#", "#########"],
        encounters: {
          rate: opts.rate ?? 1,
          table: [
            { speciesId: enemy.speciesId, minLevel: enemy.level, maxLevel: enemy.level, weight: 1 },
          ],
        },
      },
    },
    player: {
      glyph: "@",
      map: "main",
      x: 1,
      y: 1,
      party: opts.party ?? [],
      inventory: opts.inventory ?? [],
      money: opts.money ?? 0,
      ...(opts.respawn ? { respawn: opts.respawn } : {}),
    },
  };
}

function loadFixture(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

/** Fight the current battle to its end by spamming the first move. */
function fightOut(sim: Sim, maxRounds = 30): string[] {
  const events: string[] = [];
  for (let i = 0; i < maxRounds && sim.state.battle; i++) {
    events.push(...sim.act({ type: "battle_move", index: 0 }));
  }
  return events;
}

describe("validation", () => {
  it("accepts the demo game", () => {
    const result = validateGame(demoRaw);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names the fix for an unknown map character", () => {
    const bad = structuredClone(demoRaw);
    bad.maps.village.rows[1] = bad.maps.village.rows[1].replace(".", "X");
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('"X" is not in the legend');
  });

  it("rejects an entity on a non-walkable tile", () => {
    const bad = structuredClone(demoRaw);
    bad.maps.village.entities[0].x = 0;
    bad.maps.village.entities[0].y = 0;
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("non-walkable tile");
  });

  it("rejects ragged map rows", () => {
    const bad = structuredClone(demoRaw);
    bad.maps.village.rows[2] = bad.maps.village.rows[2] + ".";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("same width");
  });

  it("rejects duplicate entity ids across maps", () => {
    const bad = structuredClone(demoRaw);
    bad.maps["east-road"].entities[0].id = "elder";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("unique across the whole game");
  });

  it("rejects a player start on an unknown map", () => {
    const bad = structuredClone(demoRaw);
    bad.player.map = "nowhere";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('player.map: "nowhere" is not a defined map');
  });

  it("rejects a portal to an unknown map", () => {
    const bad = structuredClone(demoRaw);
    bad.maps.village.portals[0].toMap = "nowhere";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('"nowhere" is not a defined map');
  });

  it("rejects a portal on a non-walkable source tile", () => {
    const bad = structuredClone(demoRaw);
    bad.maps.village.portals[0].x = 0;
    bad.maps.village.portals[0].y = 0;
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("step onto a portal");
  });

  it("rejects a portal with a non-walkable destination", () => {
    const bad = structuredClone(demoRaw);
    bad.maps.village.portals[0].toX = 0;
    bad.maps.village.portals[0].toY = 0;
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("land on a walkable tile");
  });

  it("rejects two portals on the same tile", () => {
    const bad = structuredClone(demoRaw);
    bad.maps.village.portals.push({ ...bad.maps.village.portals[0] });
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("only one portal per tile");
  });

  it("rejects wild tiles without an encounters zone", () => {
    const bad = structuredClone(demoRaw);
    delete bad.maps["east-road"].encounters;
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("no encounters zone");
  });

  it("warns about an encounters zone with no wild tiles", () => {
    const odd = structuredClone(demoRaw);
    odd.maps.village.encounters = {
      rate: 0.5,
      table: [{ speciesId: "emberling", minLevel: 1, maxLevel: 2, weight: 1 }],
    };
    const result = validateGame(odd);
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("no wild tiles");
  });

  it("rejects minLevel above maxLevel", () => {
    const bad = structuredClone(demoRaw);
    bad.maps["east-road"].encounters.table[0].minLevel = 9;
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("greater than maxLevel");
  });

  it("rejects an out-of-range encounter rate", () => {
    const bad = structuredClone(demoRaw);
    bad.maps["east-road"].encounters.rate = 1.5;
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("between 0 and 1");
  });
});

describe("catalog-in-game validation", () => {
  it("requires a catalog", () => {
    const bad = structuredClone(demoRaw);
    delete bad.catalog;
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("catalog");
  });

  it("rejects an encounter species missing from the catalog", () => {
    const bad = structuredClone(demoRaw);
    bad.maps["east-road"].encounters.table[0].speciesId = "dragonx";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'speciesId "dragonx" is not in the catalog',
    );
  });

  it("rejects give_species and give_item referencing unknown ids", () => {
    const bad = structuredClone(demoRaw);
    const gift = bad.maps.village.entities[0].interactions[1];
    gift.commands[1].speciesId = "ghost";
    gift.commands[2].itemId = "potion-of-nope";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    const text = result.errors.join("\n");
    expect(text).toContain('speciesId "ghost" is not in the catalog');
    expect(text).toContain('itemId "potion-of-nope" is not in the catalog');
  });

  it("rejects a starting party member with an unknown species or level 0", () => {
    const bad = structuredClone(demoRaw);
    bad.player.party = [{ speciesId: "nessie", level: 5 }];
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('speciesId "nessie" is not in the catalog');

    const bad2 = structuredClone(demoRaw);
    bad2.player.party = [{ speciesId: "emberling", level: 0 }];
    const result2 = validateGame(bad2);
    expect(result2.ok).toBe(false);
    expect(result2.errors.join("\n")).toContain("level must be at least 1");
  });

  it("rejects a respawn on an unknown map or bad tile", () => {
    const bad = structuredClone(demoRaw);
    bad.player.respawn = { map: "nowhere", x: 1, y: 1 };
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('player.respawn.map: "nowhere" is not a defined map');

    const bad2 = structuredClone(demoRaw);
    bad2.player.respawn = { map: "village", x: 0, y: 0 };
    const result2 = validateGame(bad2);
    expect(result2.ok).toBe(false);
    expect(result2.errors.join("\n")).toContain("player.respawn");
  });

  it("validates items per kind: heal needs amount, capture needs ballMod", () => {
    const bad = structuredClone(demoRaw);
    delete bad.catalog.items[0].amount; // embersalve
    delete bad.catalog.items[1].ballMod; // kindling-snare
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    const text = result.errors.join("\n");
    expect(text).toContain('catalog.items.embersalve: heal items need an "amount"');
    expect(text).toContain('catalog.items.kindling-snare: capture items need a "ballMod"');
  });

  it("surfaces catalog cross-reference errors with a catalog. prefix", () => {
    const bad = structuredClone(demoRaw);
    bad.catalog.species[0].learnset[0].moveId = "megasmash";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(
      'catalog.species.emberling.learnset[0]: moveId "megasmash" does not exist',
    );
  });
});

describe("simulation", () => {
  it("blocks the player at walls and water", () => {
    const sim = new Sim(loadDemo());
    const events = play(sim, "west west");
    expect(events.join("\n")).toContain("can't go west");
    expect(sim.state.playerX).toBe(1);
  });

  it("guard blocks the road and refuses passage without the blessing", () => {
    const sim = new Sim(loadDemo());
    const events = play(sim, "east east east east east east east");
    expect(events.join("\n")).toContain("Guard Bram is standing there");
    expect(sim.state.playerX).toBe(8); // stopped in front of the guard
    const talk = play(sim, "interact");
    expect(talk.join("\n")).toContain("None shall pass");
    expect(sim.state.won).toBe(false);
  });

  it("full playthrough: elder gift -> guard -> win, deterministically", () => {
    const script =
      "east east east east east east north north north north interact " +
      "south south south south interact";
    const sim = new Sim(loadDemo());
    const events = play(sim, script);
    expect(sim.state.flags).toContain("elder_blessing");
    expect(sim.state.won).toBe(true);
    expect(events.join("\n")).toContain("YOU WIN");
    // The elder's gift arrived along the way.
    expect(sim.state.party.map((c) => c.speciesId)).toEqual(["emberling"]);
    expect(sim.state.inventory).toEqual([
      { itemId: "embersalve", qty: 2 },
      { itemId: "kindling-snare", qty: 3 },
    ]);
    expect(sim.state.money).toBe(45); // 20 start + 25 gift

    const sim2 = new Sim(loadDemo());
    const events2 = play(sim2, script);
    expect(events2).toEqual(events);
    expect(sim2.snapshot()).toEqual(sim.snapshot());
  });

  it("the elder's gift is one-time (forbidsFlag)", () => {
    const sim = new Sim(loadDemo());
    play(sim, "east east east east east east north north north north interact");
    expect(sim.state.party).toHaveLength(1);
    const again = play(sim, "interact");
    expect(again.join("\n")).toContain("Go on now");
    expect(sim.state.party).toHaveLength(1);
    expect(sim.state.inventory.find((e) => e.itemId === "embersalve")!.qty).toBe(2);
  });

  it("give_species fails with an event when the party is full", () => {
    const demo = structuredClone(demoRaw);
    demo.player.party = Array(6).fill({ speciesId: "fluffit", level: 2 });
    const sim = new Sim(loadFixture(demo));
    const events = play(sim, "east east east east east east north north north north interact");
    expect(events.join("\n")).toContain("Your party is full — Emberling stays with Elder Maren");
    expect(sim.state.party).toHaveLength(6);
  });

  it("heal_party at the village hearth restores HP", () => {
    const demo = structuredClone(demoRaw);
    demo.player.party = [{ speciesId: "emberling", level: 7 }];
    const sim = new Sim(loadFixture(demo));
    sim.state.party[0].hp = 1;
    const events = play(sim, "north north north north north interact");
    expect(events.join("\n")).toContain("Your kindred are rested and warm");
    expect(sim.state.party[0].hp).toBe(sim.state.party[0].maxHp);
  });

  it("observation includes map id, grid, goal, portals, party, and money", () => {
    const demo = structuredClone(demoRaw);
    demo.player.party = [{ speciesId: "emberling", level: 7 }];
    const sim = new Sim(loadFixture(demo));
    const text = observe(sim);
    expect(text).toContain("🙂");
    expect(text).toContain("Goal:");
    expect(text).toContain("Map: village");
    expect(text).toContain("Portal to east-road");
    expect(text).toContain("Biscuit the dog");
    expect(text).toContain("Party: Emberling Lv7");
    expect(text).toContain("Money: 20");
    expect(renderGrid(sim)).toContain("🧙");
  });
});

describe("shops (sell command)", () => {
  /** Demo village: Peddler Sela (5,1) sells embersalve 10; the snare stall
   *  (6,1) sells kindling-snare 20. Counters are spatial — no menus. */
  const atCounter = (x: number, money: number) => {
    const demo = structuredClone(demoRaw);
    demo.player.x = x;
    demo.player.y = 2;
    demo.player.money = money;
    return new Sim(loadFixture(demo));
  };

  it("buys an item when the player can afford it", () => {
    const sim = atCounter(5, 20);
    const events = play(sim, "interact");
    const text = events.join("\n");
    expect(text).toContain("Embersalve, fresh from the kiln");
    expect(text).toContain("Bought an Embersalve for 10.");
    expect(sim.state.money).toBe(10);
    expect(sim.state.inventory).toEqual([{ itemId: "embersalve", qty: 1 }]);

    play(sim, "interact"); // buy a second one
    expect(sim.state.money).toBe(0);
    expect(sim.state.inventory).toEqual([{ itemId: "embersalve", qty: 2 }]);
  });

  it("names the shortfall when money runs out, without giving the item", () => {
    const sim = atCounter(5, 4);
    const events = play(sim, "interact");
    expect(events.join("\n")).toContain(
      "You can't afford an Embersalve — it costs 10 and you have 4 (6 short).",
    );
    expect(sim.state.money).toBe(4);
    expect(sim.state.inventory).toEqual([]);
  });

  it("each counter sells its own item", () => {
    const sim = atCounter(6, 20);
    const events = play(sim, "interact");
    expect(events.join("\n")).toContain("Bought a Kindling Snare for 20.");
    expect(sim.state.money).toBe(0);
    expect(sim.state.inventory).toEqual([{ itemId: "kindling-snare", qty: 1 }]);
  });

  it("validation rejects sell commands with unknown items or negative prices", () => {
    const bad = structuredClone(demoRaw);
    const peddler = bad.maps.village.entities.find((e: { id: string }) => e.id === "peddler");
    peddler.interactions[0].commands[1].itemId = "moon-rock";
    const result = validateGame(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('itemId "moon-rock" is not in the catalog');

    const bad2 = structuredClone(demoRaw);
    const peddler2 = bad2.maps.village.entities.find((e: { id: string }) => e.id === "peddler");
    peddler2.interactions[0].commands[1].price = -5;
    const result2 = validateGame(bad2);
    expect(result2.ok).toBe(false);
    expect(result2.errors.join("\n")).toContain("price must be zero or more");
  });
});

describe("wild battles", () => {
  it("blocks stepping into tall grass with an empty party", () => {
    const sim = new Sim(loadFixture(wildFixture({ party: [] })));
    const events = play(sim, "east");
    expect(events.join("\n")).toContain(
      "You shouldn't step into the tall grass without a kindred.",
    );
    expect(sim.state.playerX).toBe(1);
    expect(sim.state.battle).toBeNull();
  });

  it("a wild-tile hit starts a battle immediately and gates actions both ways", () => {
    const sim = new Sim(loadFixture(wildFixture({ party: [{ speciesId: "champ", level: 12 }] })));
    // battle actions are rejected on the overworld
    const noBattle = sim.act({ type: "battle_move", index: 0 });
    expect(noBattle.join("\n")).toContain("There is no battle right now");

    const events = play(sim, "east");
    expect(events.join("\n")).toContain("A wild Critter (Lv 5) appears!");
    expect(sim.state.battle).not.toBeNull();
    expect(sim.state.battle!.mode).toBe("wild");

    const rejected = play(sim, "east");
    expect(rejected.join("\n")).toContain("You are in a battle — valid actions:");
    expect(rejected.join("\n")).toContain("move1");
    expect(sim.state.playerX).toBe(2); // did not move
  });

  it("observe shows the battle view with real item and action options", () => {
    const sim = new Sim(
      loadFixture(
        wildFixture({
          party: [{ speciesId: "champ", level: 12 }],
          inventory: [{ itemId: "salve", qty: 2 }, { itemId: "snare", qty: 3 }],
        }),
      ),
    );
    play(sim, "east");
    const text = observe(sim);
    expect(text).toContain("Wild battle");
    expect(text).toContain("move1 — Smash");
    expect(text).toContain("item1 — Salve (heals 20 HP) x2");
    expect(text).toContain("item2 — Snare (capture, 1x) x3");
    expect(text).toContain("Actions: move1..move1 | item1..item2 | catch | run");
  });

  it("walk into grass -> battle -> win -> XP, level-up, move learning, evolution", () => {
    const sim = new Sim(
      loadFixture(wildFixture({ party: [{ speciesId: "sprout", level: 9 }] })),
      3,
    );
    const events = [...play(sim, "east"), ...fightOut(sim)];
    const text = events.join("\n");
    expect(text).toContain("A wild Critter (Lv 5) appears!");
    expect(text).toContain("Sprout gained 300 XP.");
    expect(text).toContain("Sprout grew to Lv 10!");
    expect(text).toContain("Sprout learned Smash!");
    expect(text).toContain("You won the battle!");
    expect(text).toContain("Sprout's flame steadies. It is Bloom now.");
    expect(sim.state.battle).toBeNull();
    const c = sim.state.party[0];
    expect(c.speciesId).toBe("bloom");
    expect(c.level).toBe(10);
    expect(c.xp).toBe(9 ** 3 + 300);
    expect(c.moves.map((m) => m.moveId)).toContain("smash");
    // overworld actions work again
    expect(play(sim, "west").join("\n")).toContain("You move west.");
  });

  it("replaces the OLDEST move when a fifth is learned, and says so", () => {
    const sim = new Sim(
      loadFixture(wildFixture({ party: [{ speciesId: "learner", level: 9 }] })),
      3,
    );
    const events = [...play(sim, "east"), ...fightOut(sim)];
    expect(events.join("\n")).toContain("Learner forgot Tackle and learned Smash!");
    const moves = sim.state.party[0].moves.map((m) => m.moveId);
    expect(moves).toEqual(["poke", "jab", "flick", "smash"]);
  });

  it("run clears the battle when escape succeeds", () => {
    // champ spd 99 vs critter spd 10 -> escape chance clamps to 0.95
    const sim = new Sim(loadFixture(wildFixture({ party: [{ speciesId: "champ", level: 12 }] })), 2);
    play(sim, "east");
    for (let i = 0; i < 10 && sim.state.battle; i++) sim.act({ type: "battle_run" });
    expect(sim.state.battle).toBeNull();
    expect(sim.state.lastEvents.join("\n")).toContain("You got away safely!");
  });

  it("defeat heals the party, respawns the player, and halves money", () => {
    const sim = new Sim(
      loadFixture(
        wildFixture({
          party: [{ speciesId: "critter", level: 2 }],
          money: 50,
          enemy: { speciesId: "champ", level: 12 },
          respawn: { map: "main", x: 1, y: 1 },
        }),
      ),
      1,
    );
    play(sim, "east");
    expect(sim.state.playerX).toBe(2);
    const events = fightOut(sim);
    const text = events.join("\n");
    expect(text).toContain("You have no creatures left. You lost the battle!");
    expect(text).toContain("Everything goes quiet for a moment. You wake by the hearth");
    expect(sim.state.battle).toBeNull();
    expect(sim.state.playerX).toBe(1);
    expect(sim.state.playerY).toBe(1);
    expect(sim.state.money).toBe(25);
    expect(sim.state.party[0].hp).toBe(sim.state.party[0].maxHp);
  });

  it("heal items restore HP in battle and consume the turn and the item", () => {
    const sim = new Sim(
      loadFixture(
        wildFixture({
          party: [{ speciesId: "sprout", level: 9 }],
          inventory: [{ itemId: "salve", qty: 2 }],
        }),
      ),
      3,
    );
    play(sim, "east");
    sim.act({ type: "battle_move", index: 0 }); // trade blows once
    const me = sim.state.party[0];
    expect(me.hp).toBeLessThan(me.maxHp);
    const events = sim.act({ type: "battle_item", index: 0 });
    const text = events.join("\n");
    expect(text).toContain("You used Salve. Sprout recovered");
    expect(text).toContain("Enemy Critter used"); // enemy's turn still happens
    expect(sim.state.inventory).toEqual([{ itemId: "salve", qty: 1 }]);
  });

  it("catch succeeds on some seeds and fails on others, deterministically", () => {
    const scenario = (seed: number) => {
      const sim = new Sim(
        loadFixture(
          wildFixture({
            party: [{ speciesId: "champ", level: 12 }],
            inventory: [{ itemId: "snare", qty: 2 }],
          }),
        ),
        seed,
      );
      play(sim, "east");
      const events = sim.act({ type: "battle_catch" });
      return { sim, text: events.join("\n") };
    };

    let successSeed = -1;
    let failureSeed = -1;
    for (let seed = 1; seed <= 60 && (successSeed === -1 || failureSeed === -1); seed++) {
      const { sim, text } = scenario(seed);
      if (text.includes("was caught!") && successSeed === -1) successSeed = seed;
      if (text.includes("broke free!") && failureSeed === -1) failureSeed = seed;
      // either way the snare is spent
      expect(sim.state.inventory[0].qty).toBe(1);
    }
    expect(successSeed).toBeGreaterThan(0);
    expect(failureSeed).toBeGreaterThan(0);

    const success = scenario(successSeed);
    expect(success.text).toContain("You threw a Snare!");
    expect(success.text).toContain("Gotcha! The wild Critter was caught!");
    expect(success.text).toContain("Critter joined your party!");
    expect(success.sim.state.battle).toBeNull();
    expect(success.sim.state.party.map((c) => c.speciesId)).toEqual(["champ", "critter"]);

    const failure = scenario(failureSeed);
    expect(failure.text).toContain("The wild Critter broke free!");
    expect(failure.text).toContain("Enemy Critter used"); // failed catch costs the turn
    expect(failure.sim.state.battle).not.toBeNull();

    // same seed, same outcome
    expect(scenario(successSeed).text).toEqual(success.text);
    expect(scenario(failureSeed).text).toEqual(failure.text);
  });

  it("catch with no capture item costs nothing", () => {
    const sim = new Sim(loadFixture(wildFixture({ party: [{ speciesId: "champ", level: 12 }] })));
    play(sim, "east");
    const round = sim.state.battle!.round;
    const events = sim.act({ type: "battle_catch" });
    expect(events.join("\n")).toContain("You have nothing to catch with");
    expect(sim.state.battle!.round).toBe(round);
  });

  it("a caught creature is gently released when the party is full", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const sim = new Sim(
        loadFixture(
          wildFixture({
            party: Array(6).fill({ speciesId: "champ", level: 12 }),
            inventory: [{ itemId: "snare", qty: 1 }],
          }),
        ),
        seed,
      );
      play(sim, "east");
      const text = sim.act({ type: "battle_catch" }).join("\n");
      if (text.includes("was caught!")) {
        expect(text).toContain("Your party is full");
        expect(sim.state.party).toHaveLength(6);
        expect(sim.state.battle).toBeNull();
        return;
      }
    }
    throw new Error("no successful catch in 60 seeds — check the catch formula");
  });

  it("same seed + action list replays identically through battles, and snapshots survive JSON", () => {
    const script =
      "east east catch move1 east east move1 move1 move1 move1 move1 move1 west west west";
    const run = () => {
      const sim = new Sim(
        loadFixture(
          wildFixture({
            rate: 0.6,
            party: [{ speciesId: "sprout", level: 9 }],
            inventory: [{ itemId: "salve", qty: 1 }, { itemId: "snare", qty: 2 }],
          }),
        ),
        11,
      );
      const events = play(sim, script);
      return { events, snapshot: sim.snapshot() };
    };
    const a = run();
    const b = run();
    expect(b.events).toEqual(a.events);
    expect(b.snapshot).toEqual(a.snapshot);
    expect(JSON.parse(JSON.stringify(a.snapshot))).toEqual(a.snapshot);
  });

  it("different seeds can produce different outcomes", () => {
    const walk = (seed: number) => {
      const sim = new Sim(
        loadFixture(wildFixture({ rate: 0.5, party: [{ speciesId: "champ", level: 12 }] })),
        seed,
      );
      const events: string[] = [];
      for (let i = 0; i < 24; i++) {
        if (sim.state.battle) {
          events.push(...sim.act({ type: "battle_move", index: 0 }));
          continue;
        }
        const dir = sim.state.playerX >= 7 ? "west" : "east";
        events.push(...sim.act({ type: "move", dir: dir as "east" | "west" }));
      }
      return events;
    };
    const baseline = walk(1);
    expect(baseline.join("\n")).toContain("appears!");
    let foundDifference = false;
    for (let seed = 2; seed <= 10 && !foundDifference; seed++) {
      if (JSON.stringify(walk(seed)) !== JSON.stringify(baseline)) foundDifference = true;
    }
    expect(foundDifference).toBe(true);
  });

  it("demo: full run with a wild battle stays deterministic and winnable", () => {
    const run = (seed: number) => {
      const sim = new Sim(loadDemo(), seed);
      const events: string[] = [];
      // elder gift, then out east through the guard into the grass
      events.push(
        ...play(
          sim,
          "east east east east east east north north north north interact " +
            "south south south south east east east",
        ),
      );
      expect(sim.state.map).toBe("east-road");
      // pace the grass until a battle starts, then win it
      for (let i = 0; i < 60 && !sim.state.battle; i++) {
        const dir = sim.state.playerX >= 8 ? "west" : "east";
        events.push(...sim.act({ type: "move", dir: dir as "east" | "west" }));
      }
      expect(sim.state.battle).not.toBeNull();
      events.push(...fightOut(sim));
      expect(sim.state.battle).toBeNull();
      // walk home (fighting any further battles) and win at the guard
      for (let i = 0; i < 200 && sim.state.map === "east-road"; i++) {
        if (sim.state.battle) {
          events.push(...sim.act({ type: "battle_move", index: 0 }));
          continue;
        }
        events.push(...sim.act({ type: "move", dir: "west" }));
      }
      expect(sim.state.map).toBe("village");
      events.push(...play(sim, "interact")); // guard is adjacent to the portal exit
      return { events, snapshot: sim.snapshot(), won: sim.state.won };
    };
    const a = run(7);
    const b = run(7);
    expect(a.won).toBe(true);
    expect(a.events.join("\n")).toContain("gained");
    expect(b.events).toEqual(a.events);
    expect(b.snapshot).toEqual(a.snapshot);
  });
});

describe("scripted demo win (CLI --actions parity)", () => {
  // The exact word list a stateless agent can pass to `npm run play -- --actions ...`
  // (default seed 1): elder gift, out east, one wild battle won, home, win.
  const WINNING_SCRIPT =
    "east,east,east,east,east,east,north,north,north,north,interact," +
    "south,south,south,south,east,east,east,east,east,east,east," +
    "move1,move1,move1,west,west,west,west,west,interact";

  it("wins the demo, battle included, on the default seed", () => {
    const sim = new Sim(loadDemo()); // seed 1, same as the CLI
    const events = play(sim, WINNING_SCRIPT);
    const text = events.join("\n");
    expect(text).toContain("appears!");
    expect(text).toContain("gained");
    expect(text).toContain("You won the battle!");
    expect(text).toContain("*** YOU WIN ***");
    expect(sim.state.won).toBe(true);
  });
});

describe("parseAction battle forms", () => {
  it("parses battle actions with 1-based slots", () => {
    expect(parseAction("move1")).toEqual({ type: "battle_move", index: 0 });
    expect(parseAction("m4")).toEqual({ type: "battle_move", index: 3 });
    expect(parseAction("switch2")).toEqual({ type: "battle_switch", index: 1 });
    expect(parseAction("s6")).toEqual({ type: "battle_switch", index: 5 });
    expect(parseAction("item9")).toEqual({ type: "battle_item", index: 8 });
    expect(parseAction("catch")).toEqual({ type: "battle_catch" });
    expect(parseAction("snare")).toEqual({ type: "battle_catch" });
    expect(parseAction("run")).toEqual({ type: "battle_run" });
    // bare "s" still means south
    expect(parseAction("s")).toEqual({ type: "move", dir: "south" });
    expect(parseAction("move5")).toBeUndefined();
    expect(parseAction("switch7")).toBeUndefined();
  });
});
