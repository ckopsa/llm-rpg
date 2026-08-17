import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRoster,
  buildLearnset,
  deriveCombatStats,
  RosterSchema,
  validateGame,
  type Game,
  type Roster,
  type RosterResult,
} from "../src/index.js";

/**
 * Roster overlays: a child-made species layered onto a shipped game without
 * touching it. Tests cover (a) the happy path stays validateGame-clean, (b)
 * the source game is never mutated, (c) every balance rule rejects with a
 * message naming the fix, and (d) an unknown move/type/map is reported, not
 * thrown.
 */

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

const fixture = (): unknown => ({
  meta: { id: "roster-test", title: "Roster Test", goal: "Catch things." },
  catalog: {
    typeChart: {
      types: ["fire", "water"],
      effectiveness: { fire: { water: 0.5 }, water: { fire: 2 } },
    },
    moves: [
      { id: "ember", name: "Ember", type: "fire", category: "physical", power: 10, accuracy: 0.9, pp: 15 },
      { id: "splash", name: "Splash", type: "water", category: "physical", power: 8, accuracy: 1, pp: 20 },
      { id: "guard", name: "Guard", type: "water", category: "status", power: 0, accuracy: 1, pp: 10, effect: { kind: "raise_def" } },
    ],
    species: [
      {
        id: "sparky",
        name: "Sparky",
        glyph: "S",
        types: ["fire"],
        baseStats: { hp: 50, atk: 40, def: 30, spd: 30 },
        learnset: [{ level: 1, moveId: "ember" }],
        catchRate: 0.4,
        xpYield: 60,
      },
    ],
    items: [],
  },
  legend: {
    "#": { name: "wall", glyph: "#", walkable: false },
    ".": { name: "floor", glyph: ".", walkable: true },
    "~": { name: "grass", glyph: "~", walkable: true, wild: true },
  },
  maps: {
    town: {
      rows: ["####", "#..#", "####"],
      entities: [],
      portals: [],
    },
    route: {
      rows: ["####", "#~~#", "####"],
      entities: [],
      portals: [],
      encounters: { rate: 0.2, table: [{ speciesId: "sparky", minLevel: 2, maxLevel: 4, weight: 1 }] },
    },
  },
  player: { glyph: "@", map: "town", x: 1, y: 1, party: [{ speciesId: "sparky", level: 5 }], money: 0, inventory: [] },
});

/** A single valid roster entry against the fixture game above. */
function validRosterDoc(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    entries: [
      {
        id: "puddlekin",
        name: "Puddlekin",
        glyph: "P",
        types: ["water"],
        baseStats: { hp: 70, atk: 50, def: 60, spd: 60 },
        moves: ["splash", "guard"],
        location: { mapId: "route", minLevel: 2, maxLevel: 5 },
        ...overrides,
      },
    ],
  };
}

function parseRoster(raw: unknown): Roster {
  const parsed = RosterSchema.parse(raw);
  return parsed;
}

describe("applyRoster", () => {
  it("happy path: appends the species and encounter, and stays validateGame-clean", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc());
    const result = applyRoster(game, roster);

    expect(result.errors).toEqual([]);
    expect(result.game.catalog!.species.some((s) => s.id === "puddlekin")).toBe(true);
    expect(result.game.maps.route.encounters!.table.some((e) => e.speciesId === "puddlekin")).toBe(true);

    const check = validateGame(result.game);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("never mutates the source game", () => {
    const raw = fixture();
    const game = load(raw);
    const before = JSON.parse(JSON.stringify(game));
    const roster = parseRoster(validRosterDoc());

    applyRoster(game, roster);

    expect(game).toEqual(before);
    expect(game.catalog!.species.length).toBe(1);
    expect(game.maps.route.encounters!.table.length).toBe(1);
  });

  it("derives catchRate and xpYield rather than accepting author values", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc());
    const result = applyRoster(game, roster);
    const species = result.game.catalog!.species.find((s) => s.id === "puddlekin")!;

    // Not the (nonexistent) author-supplied values — computed from the stat shape.
    expect(species.catchRate).toBeGreaterThan(0);
    expect(species.catchRate).toBeLessThanOrEqual(0.95);
    expect(Number.isInteger(species.xpYield)).toBe(true);
    expect(species.xpYield).toBeGreaterThan(0);
  });

  it("generates a learnset shaped like the shipped species (starts at level 1, ascending, one entry per move)", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc());
    const result = applyRoster(game, roster);
    const species = result.game.catalog!.species.find((s) => s.id === "puddlekin")!;

    expect(species.learnset.length).toBe(2);
    expect(species.learnset[0].level).toBe(1);
    for (let i = 1; i < species.learnset.length; i++) {
      expect(species.learnset[i].level).toBeGreaterThanOrEqual(species.learnset[i - 1].level);
    }
  });

  it("rejects a stat total that isn't exactly 240, naming the fix", () => {
    const game = load(fixture());
    const roster = parseRoster(
      validRosterDoc({ baseStats: { hp: 70, atk: 50, def: 60, spd: 50 } }), // totals 230
    );
    const result = applyRoster(game, roster);

    expect(result.errors.some((e) => e.includes("must equal exactly 240") && e.includes("adjust the stats by 10"))).toBe(
      true,
    );
    expect(result.game.catalog!.species.some((s) => s.id === "puddlekin")).toBe(false);
  });

  it("rejects an unknown move id, naming it, without throwing", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc({ moves: ["splash", "does-not-exist"] }));

    let result: RosterResult | undefined;
    expect(() => {
      result = applyRoster(game, roster);
    }).not.toThrow();

    expect(result!.errors.some((e) => e.includes('"does-not-exist"') && e.includes("not in the target game's catalog"))).toBe(
      true,
    );
    expect(result!.game.catalog!.species.some((s) => s.id === "puddlekin")).toBe(false);
  });

  it("rejects an unknown type id, naming it", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc({ types: ["grass"] }));
    const result = applyRoster(game, roster);

    expect(
      result.errors.some((e) => e.includes('"grass"') && e.includes("not in the target game's typeChart")),
    ).toBe(true);
    expect(result.game.catalog!.species.some((s) => s.id === "puddlekin")).toBe(false);
  });

  it("rejects an id that collides with a shipped species", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc({ id: "sparky" }));
    const result = applyRoster(game, roster);

    expect(result.errors.some((e) => e.includes("collides with a shipped species"))).toBe(true);
    expect(result.game.catalog!.species.length).toBe(1);
  });

  it("rejects two roster entries sharing an id, applying only the first", () => {
    const game = load(fixture());
    const roster = parseRoster({
      version: 1,
      entries: [
        (validRosterDoc() as { entries: unknown[] }).entries[0],
        { ...(validRosterDoc() as { entries: [Record<string, unknown>] }).entries[0], name: "Puddlekin Two" },
      ],
    });
    const result = applyRoster(game, roster);

    expect(result.errors.some((e) => e.includes("used by another entry in this roster"))).toBe(true);
    expect(result.game.catalog!.species.filter((s) => s.id === "puddlekin").length).toBe(1);
  });

  it("rejects an unknown map id, naming it, without throwing", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc({ location: { mapId: "nowhere", minLevel: 1, maxLevel: 3 } }));

    let result: RosterResult | undefined;
    expect(() => {
      result = applyRoster(game, roster);
    }).not.toThrow();

    expect(result!.errors.some((e) => e.includes('"nowhere"') && e.includes("does not exist in the target game"))).toBe(
      true,
    );
  });

  it("rejects minLevel greater than maxLevel", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc({ location: { mapId: "route", minLevel: 8, maxLevel: 3 } }));
    const result = applyRoster(game, roster);

    expect(result.errors.some((e) => e.includes("minLevel 8 is greater than maxLevel 3"))).toBe(true);
  });

  it("rejects applying a roster to a catalog-free (narrative) game", () => {
    const narrative = load({
      meta: { id: "no-catalog", title: "Words Only", goal: "Walk east." },
      legend: { ".": { name: "floor", glyph: ".", walkable: true } },
      maps: { room: { rows: ["..."], entities: [], portals: [] } },
      player: { glyph: "@", map: "room", x: 0, y: 0, party: [], money: 0, inventory: [] },
    });
    const roster = parseRoster(validRosterDoc());
    const result = applyRoster(narrative, roster);

    expect(result.errors.some((e) => e.includes("target game has no catalog"))).toBe(true);
    expect(result.game).toEqual(narrative);
  });

  it("warns (but still applies) when the target map has no wild tiles or encounter zone yet", () => {
    const game = load(fixture());
    const roster = parseRoster(validRosterDoc({ location: { mapId: "town", minLevel: 1, maxLevel: 3 } }));
    const result = applyRoster(game, roster);

    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("no wild tiles"))).toBe(true);
    expect(result.game.catalog!.species.some((s) => s.id === "puddlekin")).toBe(true);
    expect(result.game.maps.town.encounters!.table.some((e) => e.speciesId === "puddlekin")).toBe(true);
  });

  it("deriveCombatStats: an offense-heavy build is harder to catch and worth more xp than a bulky build at the same total", () => {
    const bulky = deriveCombatStats({ hp: 150, atk: 30, def: 50, spd: 10 }); // total 240
    const offensive = deriveCombatStats({ hp: 40, atk: 110, def: 20, spd: 70 }); // total 240

    expect(offensive.catchRate).toBeLessThan(bulky.catchRate);
    expect(offensive.xpYield).toBeGreaterThan(bulky.xpYield);
    expect(bulky.catchRate).toBeGreaterThanOrEqual(0.05);
    expect(offensive.catchRate).toBeLessThanOrEqual(0.95);
  });

  it("buildLearnset: one entry per move, first two at level 1 when there are >= 2 moves", () => {
    const single = buildLearnset(["a"]);
    expect(single).toEqual([{ level: 1, moveId: "a" }]);

    const seven = buildLearnset(["a", "b", "c", "d", "e", "f", "g"]);
    expect(seven.map((e) => e.level)[0]).toBe(1);
    expect(seven.map((e) => e.level)[1]).toBe(1);
    expect(seven.length).toBe(7);
    expect(seven[seven.length - 1].level).toBeLessThanOrEqual(22);
  });

  it("applies cleanly against the real games/emberwood/game.json, staying validateGame-clean", () => {
    const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
    const raw = JSON.parse(readFileSync(join(ROOT, "games/emberwood/game.json"), "utf8"));
    const game = load(raw);
    const catalog = game.catalog!;

    const [mapId] = Object.entries(game.maps).find(([, m]) => m.encounters)!;
    const [typeA] = catalog.typeChart.types;
    const [moveA, moveB] = catalog.moves.map((m) => m.id);

    const roster = parseRoster({
      version: 1,
      entries: [
        {
          id: "studio-critter",
          name: "Studio Critter",
          glyph: "✨",
          types: [typeA],
          baseStats: { hp: 70, atk: 50, def: 60, spd: 60 },
          moves: [moveA, moveB],
          location: { mapId, minLevel: 2, maxLevel: 5 },
        },
      ],
    });

    const result = applyRoster(game, roster);
    expect(result.errors).toEqual([]);

    const check = validateGame(result.game);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.ok).toBe(true);
  });
});
