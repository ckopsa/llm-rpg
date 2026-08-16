import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  validateCatalog,
  speciesById,
  moveById,
  statsAtLevel,
  movesKnownAtLevel,
  typeMultiplier,
} from "../src/catalog.js";
import type { Catalog } from "../src/catalog.js";

const fixturePath = fileURLToPath(new URL("./fixtures/catalog.json", import.meta.url));
const fixtureRaw = JSON.parse(readFileSync(fixturePath, "utf8"));

function loadFixture(): Catalog {
  const result = validateCatalog(fixtureRaw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.catalog!;
}

describe("catalog validation", () => {
  it("accepts the fixture catalog", () => {
    const result = validateCatalog(fixtureRaw);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names the fix for an unknown learnset moveId", () => {
    const bad = structuredClone(fixtureRaw);
    bad.species[0].learnset[0].moveId = "megasmash";
    const result = validateCatalog(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('moveId "megasmash" does not exist');
  });

  it("names the fix for a species type missing from the chart", () => {
    const bad = structuredClone(fixtureRaw);
    bad.species[0].types = ["lava"];
    const result = validateCatalog(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('type "lava" is not in typeChart.types');
  });

  it("names the fix for a bad evolution target", () => {
    const bad = structuredClone(fixtureRaw);
    bad.species[0].evolvesTo = { speciesId: "megawyrm", level: 16 };
    const result = validateCatalog(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('"megawyrm" does not exist');
  });

  it("rejects duplicate move and species ids", () => {
    const bad = structuredClone(fixtureRaw);
    bad.moves.push({ ...bad.moves[0] });
    bad.species.push({ ...bad.species[0] });
    const result = validateCatalog(bad);
    expect(result.ok).toBe(false);
    const text = result.errors.join("\n");
    expect(text).toContain('moves: duplicate id "bonk"');
    expect(text).toContain('species: duplicate id "emberling"');
  });

  it("rejects an unsorted learnset and a missing level-1 move", () => {
    const bad = structuredClone(fixtureRaw);
    bad.species[0].learnset = [
      { level: 7, moveId: "honefangs" },
      { level: 1, moveId: "bonk" },
    ];
    const result = validateCatalog(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("sort the learnset by level");

    const bad2 = structuredClone(fixtureRaw);
    bad2.species[0].learnset = [{ level: 5, moveId: "bonk" }];
    const result2 = validateCatalog(bad2);
    expect(result2.ok).toBe(false);
    expect(result2.errors.join("\n")).toContain("no level-1 move");
  });

  it("rejects status moves with power and bad chart multipliers", () => {
    const bad = structuredClone(fixtureRaw);
    bad.moves.find((m: { id: string }) => m.id === "honefangs").power = 40;
    bad.typeChart.effectiveness.fire.grass = 3;
    const result = validateCatalog(bad);
    expect(result.ok).toBe(false);
    const text = result.errors.join("\n");
    expect(text).toContain("status moves must have power 0");
    expect(text).toContain("multiplier 3 must be one of 0, 0.5, 1, 2");
  });
});

describe("catalog helpers", () => {
  const catalog = loadFixture();

  it("looks up species and moves by id, naming misses", () => {
    expect(speciesById(catalog, "emberling").name).toBe("Emberling");
    expect(moveById(catalog, "flamejet").power).toBe(40);
    expect(() => speciesById(catalog, "nope")).toThrow('no species with id "nope"');
    expect(() => moveById(catalog, "nope")).toThrow('no move with id "nope"');
  });

  it("derives stats at a level", () => {
    const emberling = speciesById(catalog, "emberling");
    // hp = floor(2*44*5/100) + 5 + 10 = 19; atk = floor(2*52*5/100) + 5 = 10
    expect(statsAtLevel(emberling, 5)).toEqual({ hp: 19, atk: 10, def: 9, spd: 11 });
  });

  it("returns the last 4 moves known at a level", () => {
    const emberling = speciesById(catalog, "emberling");
    expect(movesKnownAtLevel(emberling, 5)).toEqual(["bonk", "flamejet"]);
    expect(movesKnownAtLevel(emberling, 13)).toEqual([
      "bonk",
      "flamejet",
      "honefangs",
      "blazeburst",
    ]);
    const overloaded = {
      ...emberling,
      learnset: [
        { level: 1, moveId: "bonk" },
        { level: 1, moveId: "flamejet" },
        { level: 3, moveId: "honefangs" },
        { level: 5, moveId: "dustkick" },
        { level: 9, moveId: "blazeburst" },
      ],
    };
    expect(movesKnownAtLevel(overloaded, 10)).toEqual([
      "flamejet",
      "honefangs",
      "dustkick",
      "blazeburst",
    ]);
  });

  it("multiplies effectiveness across dual defender types, defaulting to 1", () => {
    const chart = catalog.typeChart;
    expect(typeMultiplier(chart, "fire", ["grass"])).toBe(2);
    expect(typeMultiplier(chart, "water", ["rock", "grass"])).toBe(1); // 2 * 0.5
    expect(typeMultiplier(chart, "electric", ["rock"])).toBe(0);
    expect(typeMultiplier(chart, "normal", ["normal"])).toBe(1); // unlisted pair
  });
});
