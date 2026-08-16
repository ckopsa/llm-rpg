import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Sim,
  loadSaveFile,
  makeSaveFile,
  parseAction,
  validateGame,
} from "../src/index.js";
import type { Action, Game, SaveFile } from "../src/index.js";

/**
 * Save/load: Sim.fromSnapshot restores everything (position, map, flags,
 * party, inventory, money, battle, rng) so a save + load mid-run — even
 * mid-battle — continues identically to a run that never stopped. The
 * SaveFile codec adds the gameId/gameVersion guard.
 */

const demoPath = fileURLToPath(new URL("../../../games/demo/game.json", import.meta.url));
const demoRaw = JSON.parse(readFileSync(demoPath, "utf8"));

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

/** Save via the codec, force a real JSON round-trip, and load. */
function roundTrip(sim: Sim, game: Game): { sim: Sim; warnings: string[] } {
  const json = JSON.stringify(makeSaveFile(sim));
  return loadSaveFile(game, JSON.parse(json));
}

/** Single-map fixture: guaranteed wild grass plus a watching trainer. */
const battleRaw = {
  meta: { id: "save-test", title: "Save Test", goal: "test saves" },
  catalog: {
    typeChart: { types: ["normal"], effectiveness: {} },
    moves: [
      { id: "smash", name: "Smash", type: "normal", category: "physical", power: 100, accuracy: 1, pp: 20 },
      { id: "poke", name: "Poke", type: "normal", category: "physical", power: 10, accuracy: 1, pp: 30 },
    ],
    species: [
      // Poke only: battles last several rounds, so mid-battle saves are meaningful.
      { id: "champ", name: "Champ", glyph: "🐯", types: ["normal"],
        baseStats: { hp: 80, atk: 90, def: 80, spd: 99 },
        learnset: [{ level: 1, moveId: "poke" }],
        catchRate: 0.5, xpYield: 60 },
      { id: "critter", name: "Critter", glyph: "🐛", types: ["normal"],
        baseStats: { hp: 30, atk: 20, def: 20, spd: 10 },
        learnset: [{ level: 1, moveId: "poke" }],
        catchRate: 0.5, xpYield: 300 },
    ],
    items: [{ id: "snare", name: "Snare", kind: "capture", ballMod: 1 }],
  },
  legend: {
    "#": { name: "wall", glyph: "#", walkable: false },
    ".": { name: "floor", glyph: ".", walkable: true },
    "*": { name: "grass", glyph: "*", walkable: true, wild: true },
  },
  maps: {
    main: {
      rows: ["#########", "#..***..#", "#.......#", "#########"],
      entities: [
        {
          id: "watcher",
          name: "Watcher Wren",
          glyph: "W",
          x: 7,
          y: 2,
          trainer: {
            party: [{ speciesId: "critter", level: 3 }, { speciesId: "critter", level: 4 }],
            defeatFlag: "wren_beaten",
            lineOfSight: { dir: "west", range: 4 },
            rewardMoney: 30,
            defeatText: "Sharp eyes, sharper kindred.",
          },
        },
      ],
      encounters: {
        rate: 1,
        table: [{ speciesId: "critter", minLevel: 5, maxLevel: 5, weight: 1 }],
      },
    },
  },
  player: {
    glyph: "@",
    map: "main",
    x: 1,
    y: 1,
    party: [{ speciesId: "champ", level: 10 }],
    inventory: [{ itemId: "snare", qty: 3 }],
    money: 40,
    respawn: { map: "main", x: 1, y: 1 },
  },
};

describe("Sim.fromSnapshot", () => {
  it("round-trips overworld state exactly and continues identically", () => {
    const game = load(demoRaw);
    const partial = "east east east east east east north north north north interact";
    const rest = "south south south south interact";

    const uninterrupted = new Sim(game);
    const restEvents = (() => {
      play(uninterrupted, partial);
      return play(uninterrupted, rest);
    })();

    const original = new Sim(game);
    play(original, partial);
    const snap = original.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap); // plain JSON
    const restored = Sim.fromSnapshot(game, JSON.parse(JSON.stringify(snap)));
    expect(restored.snapshot()).toEqual(snap);
    expect(restored.state.flags).toContain("elder_blessing");
    expect(restored.state.party.map((c) => c.speciesId)).toEqual(["emberling"]);
    expect(restored.state.money).toBe(45);

    const restoredEvents = play(restored, rest);
    expect(restoredEvents).toEqual(restEvents);
    expect(restored.state.won).toBe(true);
    expect(restored.snapshot()).toEqual(uninterrupted.snapshot());
  });

  it("restores a mid-battle wild save: identical continuation, items included", () => {
    const game = load(battleRaw);
    const toBattle = "east east"; // (3,1) is grass, rate 1 -> battle
    const continueScript: Action[] = [
      { type: "battle_move", index: 0 },
      { type: "battle_catch" },
      { type: "battle_move", index: 0 },
      { type: "battle_move", index: 0 },
    ];

    const run = (interrupt: boolean) => {
      let sim = new Sim(game, 9);
      play(sim, toBattle);
      expect(sim.state.battle).not.toBeNull();
      sim.act({ type: "battle_move", index: 0 });
      if (interrupt) {
        const loaded = roundTrip(sim, game);
        expect(loaded.warnings).toEqual([]);
        sim = loaded.sim;
        expect(sim.state.battle).not.toBeNull();
        expect(sim.state.battle!.mode).toBe("wild");
      }
      const events: string[] = [];
      for (const action of continueScript) {
        if (!sim.state.battle) break;
        events.push(...sim.act(action));
      }
      return { events, snapshot: sim.snapshot() };
    };

    const straight = run(false);
    const interrupted = run(true);
    expect(straight.events.length).toBeGreaterThan(0);
    expect(interrupted.events).toEqual(straight.events);
    expect(interrupted.snapshot).toEqual(straight.snapshot);
  });

  it("restores a mid-trainer-battle save: victory still settles rewards", () => {
    const game = load(battleRaw);
    const sim = new Sim(game, 4);
    play(sim, "south east east"); // row 2 into Wren's sight (x3, range 4)
    expect(sim.state.battle).not.toBeNull();
    expect(sim.state.battle!.mode).toBe("trainer");
    expect(sim.state.battleTrainer).toBe("watcher");
    sim.act({ type: "battle_move", index: 0 }); // one round in

    const restored = roundTrip(sim, game).sim;
    expect(restored.state.battleTrainer).toBe("watcher");
    const events: string[] = [];
    for (let i = 0; i < 30 && restored.state.battle; i++) {
      events.push(...restored.act({ type: "battle_move", index: 0 }));
    }
    const text = events.join("\n");
    expect(text).toContain("You won the battle!");
    expect(text).toContain("You won 30 coins!");
    expect(text).toContain('Watcher Wren: "Sharp eyes, sharper kindred."');
    expect(restored.state.flags).toContain("wren_beaten");
    expect(restored.state.money).toBe(70);
    // The restored battle kept mutating the same party the overworld sees.
    expect(restored.state.party[0].xp).toBeGreaterThan(1000);
  });
});

describe("save-file codec (version guard)", () => {
  it("rejects a save from a different game, naming both ids", () => {
    const game = load(demoRaw);
    const other = structuredClone(demoRaw);
    other.meta.id = "other-game";
    const otherGame = load(other);
    const file = makeSaveFile(new Sim(game));
    expect(() => loadSaveFile(otherGame, JSON.parse(JSON.stringify(file)))).toThrow(
      /belongs to game "ironwood-village".*"other-game"/,
    );
  });

  it("warns on a game-version mismatch but still loads", () => {
    const game = load(demoRaw);
    const sim = new Sim(game);
    play(sim, "east east");
    const file = JSON.parse(JSON.stringify(makeSaveFile(sim))) as SaveFile;
    file.gameVersion = "0.0.1";
    const loaded = loadSaveFile(game, file);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("0.0.1");
    expect(loaded.sim.state.playerX).toBe(4);
  });

  it("rejects data that is not a save file", () => {
    const game = load(demoRaw);
    expect(() => loadSaveFile(game, { hello: "world" })).toThrow(/Not a save file/);
    expect(() => loadSaveFile(game, null)).toThrow(/Not a save file/);
  });
});
