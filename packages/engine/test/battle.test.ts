import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rng } from "../src/rng.js";
import { validateCatalog } from "../src/catalog.js";
import type { Catalog } from "../src/catalog.js";
import { Battle, createBattle, createCombatant } from "../src/battle.js";
import type { PlayerAction } from "../src/battle.js";
import { describeBattle } from "../src/battleObserve.js";

const fixturePath = fileURLToPath(new URL("./fixtures/catalog.json", import.meta.url));
const fixtureRaw = JSON.parse(readFileSync(fixturePath, "utf8"));

function load(data: unknown): Catalog {
  const result = validateCatalog(data);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.catalog!;
}

const fixture = load(fixtureRaw);

/**
 * Inline catalog for precision tests: attackers and defenders with identical
 * stats but different types, so damage comparisons isolate one variable.
 * Attacker spd 90 >> dummy spd 10 keeps turn order fixed (no rng tiebreak).
 */
const mini = load({
  typeChart: {
    types: ["fire", "water", "grass", "normal"],
    effectiveness: { fire: { grass: 2, water: 0.5 } },
  },
  moves: [
    { id: "cinder", name: "Cinder", type: "fire", category: "physical", power: 40, accuracy: 1, pp: 25 },
    { id: "thump", name: "Thump", type: "normal", category: "physical", power: 40, accuracy: 1, pp: 25 },
    { id: "wildswing", name: "Wild Swing", type: "normal", category: "physical", power: 40, accuracy: 0.5, pp: 10 },
    { id: "lastgasp", name: "Last Gasp", type: "normal", category: "physical", power: 40, accuracy: 1, pp: 1 },
    { id: "tap", name: "Tap", type: "normal", category: "physical", power: 1, accuracy: 1, pp: 35 },
  ],
  species: [
    { id: "blazerat", name: "Blazerat", glyph: "🐀", types: ["fire"],
      baseStats: { hp: 50, atk: 50, def: 50, spd: 90 },
      learnset: [{ level: 1, moveId: "cinder" }, { level: 1, moveId: "wildswing" }],
      catchRate: 0.5, xpYield: 50 },
    { id: "plainrat", name: "Plainrat", glyph: "🐁", types: ["normal"],
      baseStats: { hp: 50, atk: 50, def: 50, spd: 90 },
      learnset: [{ level: 1, moveId: "cinder" }],
      catchRate: 0.5, xpYield: 50 },
    { id: "onetrick", name: "Onetrick", glyph: "🦔", types: ["normal"],
      baseStats: { hp: 50, atk: 50, def: 50, spd: 90 },
      learnset: [{ level: 1, moveId: "lastgasp" }],
      catchRate: 0.5, xpYield: 50 },
    { id: "grassdummy", name: "Grassdummy", glyph: "🌿", types: ["grass"],
      baseStats: { hp: 200, atk: 50, def: 50, spd: 10 },
      learnset: [{ level: 1, moveId: "tap" }],
      catchRate: 0.5, xpYield: 50 },
    { id: "waterdummy", name: "Waterdummy", glyph: "🌊", types: ["water"],
      baseStats: { hp: 200, atk: 50, def: 50, spd: 10 },
      learnset: [{ level: 1, moveId: "tap" }],
      catchRate: 0.5, xpYield: 50 },
    { id: "normaldummy", name: "Normaldummy", glyph: "⚪", types: ["normal"],
      baseStats: { hp: 200, atk: 50, def: 50, spd: 10 },
      learnset: [{ level: 1, moveId: "tap" }],
      catchRate: 0.5, xpYield: 50 },
  ],
});

function wild(
  catalog: Catalog,
  playerSpecies: string,
  playerLevel: number,
  enemySpecies: string,
  enemyLevel: number,
  seed: number,
): Battle {
  return createBattle(catalog, {
    mode: "wild",
    playerParty: [createCombatant(catalog, playerSpecies, playerLevel)],
    enemyParty: [createCombatant(catalog, enemySpecies, enemyLevel)],
    rng: new Rng(seed),
  });
}

/** Damage dealt to the enemy by the player's first move under a seed. */
function firstHitDamage(attacker: string, move: number, defender: string, seed: number) {
  const battle = wild(mini, attacker, 10, defender, 10, seed);
  const enemy = battle.state.enemy.party[0];
  const events = battle.act({ type: "move", index: move });
  return { damage: enemy.maxHp - enemy.hp, events: events.join("\n") };
}

describe("combatants", () => {
  it("creates a combatant with derived stats, xp on the cubic curve, and known moves", () => {
    const c = createCombatant(fixture, "emberling", 10);
    expect(c).toMatchObject({ speciesId: "emberling", level: 10, xp: 1000, hp: 28, maxHp: 28, atk: 15, spd: 18 });
    expect(c.moves.map((m) => m.moveId)).toEqual(["bonk", "flamejet", "honefangs"]);
    expect(c.moves[1].pp).toBe(25);
  });
});

describe("battle", () => {
  it("plays a full wild battle to victory, deterministically", () => {
    const run = () => {
      const battle = wild(fixture, "emberling", 10, "sproutle", 5, 42);
      const events: string[] = [];
      for (let i = 0; i < 20 && battle.state.outcome === "ongoing"; i++) {
        events.push(...battle.act({ type: "move", index: 1 })); // Flame Jet
      }
      return { events, state: JSON.parse(JSON.stringify(battle.state)) };
    };
    const a = run();
    const b = run();
    expect(a.state.outcome).toBe("player_won");
    expect(a.events.join("\n")).toContain("Emberling used Flame Jet!");
    expect(a.events.join("\n")).toContain("It's super effective!");
    // sproutle lv5, xpYield 64 -> floor(64 * 5 / 5) = 64 XP on the faint
    expect(a.events.join("\n")).toContain("Emberling gained 64 XP.");
    expect(a.events.join("\n")).toContain("You won the battle!");
    expect(a.state.player.party[0].xp).toBe(1064);
    expect(b.events).toEqual(a.events);
    expect(b.state).toEqual(a.state);
  });

  it("scales damage by type effectiveness", () => {
    const seed = 7;
    const vsGrass = firstHitDamage("blazerat", 0, "grassdummy", seed);
    const vsNormal = firstHitDamage("blazerat", 0, "normaldummy", seed);
    const vsWater = firstHitDamage("blazerat", 0, "waterdummy", seed);
    expect(vsGrass.events).toContain("It's super effective!");
    expect(vsWater.events).toContain("It's not very effective...");
    expect(vsGrass.damage).toBeGreaterThan(vsNormal.damage);
    expect(vsNormal.damage).toBeGreaterThan(vsWater.damage);
    // Same seed => same damage roll, so the 2x / 0.5x ratios are exact modulo flooring.
    expect(vsGrass.damage).toBeGreaterThanOrEqual(vsNormal.damage * 2 - 1);
    expect(vsWater.damage).toBeLessThanOrEqual(Math.ceil(vsNormal.damage / 2));
  });

  it("applies STAB for a move matching the attacker's type", () => {
    const seed = 7;
    const stab = firstHitDamage("blazerat", 0, "normaldummy", seed); // fire user, fire move
    const noStab = firstHitDamage("plainrat", 0, "normaldummy", seed); // normal user, fire move
    expect(stab.damage).toBeGreaterThan(noStab.damage);
    expect(stab.damage).toBeGreaterThanOrEqual(Math.floor(noStab.damage * 1.5) - 1);
  });

  it("can miss under a chosen seed", () => {
    // Seed 1: first rng value 0.6271 >= 0.5 accuracy => miss.
    const miss = firstHitDamage("blazerat", 1, "normaldummy", 1); // Wild Swing
    expect(miss.events).toContain("Wild Swing missed!");
    expect(miss.damage).toBe(0);
    // Seed 0: first rng value 0.2664 < 0.5 => hit.
    const hit = firstHitDamage("blazerat", 1, "normaldummy", 0);
    expect(hit.events).not.toContain("missed");
    expect(hit.damage).toBeGreaterThan(0);
  });

  it("falls back to Flail when all PP is exhausted", () => {
    const battle = wild(mini, "onetrick", 10, "normaldummy", 10, 3);
    battle.act({ type: "move", index: 0 }); // Last Gasp, pp 1 -> 0
    expect(battle.state.player.party[0].moves[0].pp).toBe(0);
    const enemy = battle.state.enemy.party[0];
    const before = enemy.hp;
    const events = battle.act({ type: "move", index: 0 }).join("\n");
    expect(events).toContain("has no PP left for any move!");
    expect(events).toContain("Onetrick used Flail!");
    expect(enemy.hp).toBeLessThan(before);
  });

  it("rejects a 0-PP move without consuming the round when others remain", () => {
    const battle = wild(mini, "blazerat", 10, "normaldummy", 10, 3);
    battle.state.player.party[0].moves[0].pp = 0; // drain Cinder only
    const round = battle.state.round;
    const events = battle.act({ type: "move", index: 0 }).join("\n");
    expect(events).toContain("Cinder has no PP left — choose another move.");
    expect(battle.state.round).toBe(round);
  });

  it("allows escaping a wild battle based on speed and seed", () => {
    // Emberling lv10 spd 18 vs Pebblor lv5 spd 7 => escape chance ~0.657.
    // Seed 0: first rng value 0.2664 => success.
    const escape = wild(fixture, "emberling", 10, "pebblor", 5, 0);
    const events = escape.act({ type: "run" }).join("\n");
    expect(events).toContain("You got away safely!");
    expect(escape.state.outcome).toBe("fled");

    // Seed 4: first rng value 0.9236 => failure, then the enemy attacks.
    const fail = wild(fixture, "emberling", 10, "pebblor", 5, 4);
    const failEvents = fail.act({ type: "run" }).join("\n");
    expect(failEvents).toContain("You couldn't escape!");
    expect(failEvents).toContain("Enemy Pebblor used");
    expect(fail.state.outcome).toBe("ongoing");
  });

  it("forbids running from trainer battles", () => {
    const battle = createBattle(fixture, {
      mode: "trainer",
      playerParty: [createCombatant(fixture, "emberling", 10)],
      enemyParty: [createCombatant(fixture, "pebblor", 5)],
      rng: new Rng(0),
    });
    const events = battle.act({ type: "run" }).join("\n");
    expect(events).toContain("You can't run from a trainer battle!");
    expect(battle.state.outcome).toBe("ongoing");
    expect(battle.state.round).toBe(0); // the attempt costs nothing
  });

  it("switches voluntarily and gives the enemy a free attack", () => {
    const battle = createBattle(fixture, {
      mode: "trainer",
      playerParty: [
        createCombatant(fixture, "emberling", 10),
        createCombatant(fixture, "puddlit", 10),
      ],
      enemyParty: [createCombatant(fixture, "pebblor", 5)],
      rng: new Rng(9),
    });
    const events = battle.act({ type: "switch", index: 1 }).join("\n");
    expect(events).toContain("You withdrew Emberling.");
    expect(events).toContain("Go, Puddlit!");
    expect(events).toContain("Enemy Pebblor used");
    expect(battle.state.player.active).toBe(1);
  });

  it("forces a switch after a faint, then continues", () => {
    const battle = createBattle(fixture, {
      mode: "trainer",
      playerParty: [
        createCombatant(fixture, "fluffit", 1),
        createCombatant(fixture, "emberling", 10),
      ],
      enemyParty: [createCombatant(fixture, "pebblor", 10)],
      rng: new Rng(5),
      enemyAi: () => 0, // always Pebble Toss
    });
    for (let i = 0; i < 10 && !battle.state.needsSwitch; i++) {
      battle.act({ type: "move", index: 0 });
    }
    expect(battle.state.needsSwitch).toBe(true);
    expect(battle.state.player.party[0].hp).toBe(0);

    const refused = battle.act({ type: "move", index: 0 }).join("\n");
    expect(refused).toContain("you must switch");

    const dead = battle.act({ type: "switch", index: 0 }).join("\n");
    expect(dead).toContain("has fainted and can't battle");
    expect(battle.state.needsSwitch).toBe(true);

    const events = battle.act({ type: "switch", index: 1 }).join("\n");
    expect(events).toContain("Go, Emberling!");
    expect(battle.state.needsSwitch).toBe(false);
    expect(battle.state.player.active).toBe(1);
    expect(battle.state.outcome).toBe("ongoing");
  });

  it("rejects catch in trainer battles without consuming the round", () => {
    const battle = createBattle(fixture, {
      mode: "trainer",
      playerParty: [createCombatant(fixture, "emberling", 10)],
      enemyParty: [createCombatant(fixture, "pebblor", 5)],
      rng: new Rng(0),
    });
    const events = battle.act({ type: "catch", name: "Kindling Snare", ballMod: 1 }).join("\n");
    expect(events).toContain("You can't catch another keeper's kindred!");
    expect(battle.state.round).toBe(0);
    expect(battle.state.outcome).toBe("ongoing");
  });

  it("catch can capture a weakened wild creature (clamped probability)", () => {
    // fluffit catchRate 0.6; at 1 HP the factor approaches 1.3 -> p ~ 0.78.
    let captured = 0;
    let escaped = 0;
    for (let seed = 0; seed < 20; seed++) {
      const battle = wild(fixture, "emberling", 10, "fluffit", 5, seed);
      battle.state.enemy.party[0].hp = 1;
      const events = battle.act({ type: "catch", name: "Kindling Snare", ballMod: 1 }).join("\n");
      expect(events).toContain("You threw a Kindling Snare!");
      if (battle.state.outcome === "captured") {
        captured += 1;
        expect(events).toContain("Gotcha! The wild Fluffit was caught!");
      } else {
        escaped += 1;
        expect(events).toContain("The wild Fluffit broke free!");
        expect(events).toContain("Enemy Fluffit used"); // failure costs the turn
      }
    }
    expect(captured).toBeGreaterThan(0);
    expect(escaped).toBeGreaterThan(0);
  });

  it("heal item restores HP (capped) and gives the enemy its turn", () => {
    const battle = wild(mini, "grassdummy", 10, "normaldummy", 10, 3);
    const me = battle.state.player.party[0];
    me.hp = me.maxHp - 5;
    const events = battle.act({ type: "item", name: "Salve", heal: 20 }).join("\n");
    expect(events).toContain("You used Salve. Grassdummy recovered 5 HP.");
    expect(events).toContain("Enemy Normaldummy used");
    expect(me.hp).toBeLessThanOrEqual(me.maxHp);
    expect(battle.state.round).toBe(1);
  });

  it("applies status move stat stages", () => {
    const battle = createBattle(fixture, {
      mode: "trainer",
      playerParty: [createCombatant(fixture, "emberling", 10)],
      enemyParty: [createCombatant(fixture, "pebblor", 10)],
      rng: new Rng(2),
      enemyAi: () => 1, // Hone Fangs
    });
    const events = battle.act({ type: "move", index: 2 }).join("\n"); // Hone Fangs
    expect(events).toContain("Emberling's Atk rose!");
    expect(events).toContain("Enemy Pebblor's Atk rose!");
    expect(battle.state.player.stages.atk).toBe(1);
    expect(battle.state.enemy.stages.atk).toBe(1);
  });
});

describe("describeBattle", () => {
  it("shows both actives, moves with PP, party, and valid actions", () => {
    const battle = wild(fixture, "emberling", 10, "sproutle", 5, 42);
    const text = describeBattle(fixture, battle);
    expect(text).toContain("Wild battle — round 0");
    expect(text).toContain("Enemy: 🌱 Sproutle Lv5 [grass]");
    expect(text).toContain("You:   🦎 Emberling Lv10 [fire]");
    expect(text).toContain("28/28 HP");
    expect(text).toContain("move2 — Flame Jet (fire, physical) power 40, PP 25/25");
    expect(text).toContain("[1] Emberling Lv10 28/28 HP (active)");
    expect(text).toContain("Actions: move1..move3 | run");
  });

  it("lists inventory items and offers catch when a capture item is carried", () => {
    const battle = wild(fixture, "emberling", 10, "sproutle", 5, 42);
    const text = describeBattle(fixture, battle, [
      { itemId: "embersalve", qty: 2 },
      { itemId: "kindling-snare", qty: 1 },
    ]);
    expect(text).toContain("item1 — Embersalve (heals 20 HP) x2");
    expect(text).toContain("item2 — Kindling Snare (capture, 1x) x1");
    expect(text).toContain("Actions: move1..move3 | item1..item2 | catch | run");
  });

  it("omits run in trainer battles and reports the outcome when over", () => {
    const trainer = createBattle(fixture, {
      mode: "trainer",
      playerParty: [createCombatant(fixture, "emberling", 10)],
      enemyParty: [createCombatant(fixture, "pebblor", 5)],
      rng: new Rng(0),
    });
    expect(describeBattle(fixture, trainer)).toContain("Actions: move1..move3");
    expect(describeBattle(fixture, trainer)).not.toContain("run");

    const battle = wild(fixture, "emberling", 10, "sproutle", 5, 42);
    for (let i = 0; i < 20 && battle.state.outcome === "ongoing"; i++) {
      battle.act({ type: "move", index: 1 });
    }
    const text = describeBattle(fixture, battle);
    expect(text).toContain("Outcome: you won. The battle is over.");
    expect(text).toContain("Last events:");
    expect(text).not.toContain("Actions:");
  });
});

describe("determinism with a mixed action script", () => {
  it("same seed and script produce identical logs and state", () => {
    const script: PlayerAction[] = [
      { type: "move", index: 0 },
      { type: "run" },
      { type: "move", index: 1 },
      { type: "move", index: 0 },
      { type: "run" },
    ];
    const run = () => {
      const battle = createBattle(fixture, {
        mode: "wild",
        playerParty: [
          createCombatant(fixture, "voltpup", 8),
          createCombatant(fixture, "mosskrag", 8),
        ],
        enemyParty: [createCombatant(fixture, "puddlit", 9)],
        rng: new Rng(1234),
      });
      const events: string[] = [];
      for (const action of script) {
        if (battle.state.outcome !== "ongoing") break;
        events.push(...battle.act(action));
      }
      return { events, state: JSON.parse(JSON.stringify(battle.state)) };
    };
    const a = run();
    const b = run();
    expect(b.events).toEqual(a.events);
    expect(b.state).toEqual(a.state);
    expect(a.events.length).toBeGreaterThan(0);
  });
});
