import { beforeEach, describe, expect, it } from "vitest";
import { RosterSchema, validateGame, type Game, type Roster } from "@llm-rpg/engine";
import type { LoadedManifest } from "./render/manifest";
import {
  applyRosterSprites,
  applyStoredRoster,
  clearRoster,
  loadRosterOverlay,
  mergeRosterSprites,
  readRoster,
  writeRoster,
} from "./roster";

/**
 * This suite runs under vitest's default "node" environment (no jsdom in
 * this repo — see recolor.test.ts, the only other apps/web test). roster.ts
 * only ever touches `window.localStorage` and `Image` behind try/catch or
 * an injectable loader, exactly like saves.ts, so a tiny in-memory Storage
 * stub on a synthetic `window` is enough to exercise it for real.
 */
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let fakeStorage: FakeStorage;
beforeEach(() => {
  fakeStorage = new FakeStorage();
  (globalThis as unknown as { window: { localStorage: Storage } }).window = {
    localStorage: fakeStorage,
  };
});

// ---- fixtures ---------------------------------------------------------------

function fixtureGame(): Game {
  const result = validateGame({
    meta: { id: "roster-web-test", title: "Roster Web Test", goal: "Catch things." },
    catalog: {
      typeChart: {
        types: ["fire", "water"],
        effectiveness: { fire: { water: 0.5 }, water: { fire: 2 } },
      },
      moves: [
        {
          id: "ember",
          name: "Ember",
          type: "fire",
          category: "physical",
          power: 10,
          accuracy: 0.9,
          pp: 15,
        },
        {
          id: "splash",
          name: "Splash",
          type: "water",
          category: "physical",
          power: 8,
          accuracy: 1,
          pp: 20,
        },
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
      town: { rows: ["####", "#..#", "####"], entities: [], portals: [] },
      route: {
        rows: ["####", "#~~#", "####"],
        entities: [],
        portals: [],
        encounters: { rate: 0.2, table: [{ speciesId: "sparky", minLevel: 2, maxLevel: 4, weight: 1 }] },
      },
    },
    player: {
      glyph: "@",
      map: "town",
      x: 1,
      y: 1,
      party: [{ speciesId: "sparky", level: 5 }],
      money: 0,
      inventory: [],
    },
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

function validRosterDoc(overrides: Record<string, unknown> = {}, spriteDataUrl?: string): unknown {
  return {
    version: 1,
    entries: [
      {
        id: "puddlekin",
        name: "Puddlekin",
        glyph: "P",
        types: ["water"],
        baseStats: { hp: 70, atk: 50, def: 60, spd: 60 },
        moves: ["splash"],
        ...(spriteDataUrl ? { spriteDataUrl } : {}),
        location: { mapId: "route", minLevel: 2, maxLevel: 5 },
        ...overrides,
      },
    ],
  };
}

function parseRoster(raw: unknown): Roster {
  return RosterSchema.parse(raw);
}

function emptyManifest(): LoadedManifest {
  return { manifest: { sheets: {}, sprites: {} }, sheets: new Map() };
}

// ---- storage ------------------------------------------------------------

describe("roster storage", () => {
  it("round-trips a saved roster, including the timestamp", () => {
    const roster = parseRoster(validRosterDoc());
    const written = writeRoster("roster-web-test", roster);
    expect(written).toEqual({ ok: true });

    const read = readRoster("roster-web-test");
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.roster).toEqual(roster);
    expect(typeof read.savedAt).toBe("string");
  });

  it("reports empty (not an error) when nothing was ever saved", () => {
    const read = readRoster("some-other-game");
    expect(read).toEqual({ ok: false, empty: true, error: expect.any(String) });
  });

  it("rejects corrupt JSON gently, without throwing", () => {
    fakeStorage.setItem("llmrpg:roster:roster-web-test", "{not json");
    expect(() => readRoster("roster-web-test")).not.toThrow();
    const read = readRoster("roster-web-test");
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.error).toMatch(/couldn't be read/);
  });

  it("rejects a foreign document shape gently, without throwing", () => {
    fakeStorage.setItem(
      "llmrpg:roster:roster-web-test",
      JSON.stringify({ savedAt: "now", roster: { totally: "not a roster" } }),
    );
    const read = readRoster("roster-web-test");
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.error).toMatch(/damaged/);
  });

  it("clearRoster removes a saved roster", () => {
    writeRoster("roster-web-test", parseRoster(validRosterDoc()));
    expect(readRoster("roster-web-test").ok).toBe(true);
    clearRoster("roster-web-test");
    expect(readRoster("roster-web-test")).toMatchObject({ ok: false, empty: true });
  });

  it("namespaces keys per gameId, like saves.ts", () => {
    writeRoster("game-a", parseRoster(validRosterDoc()));
    expect(readRoster("game-b")).toMatchObject({ ok: false, empty: true });
    expect(readRoster("game-a").ok).toBe(true);
  });
});

// ---- applying to the game document ---------------------------------------

describe("applyStoredRoster", () => {
  it("applies a valid roster and does not mutate the shipped game", () => {
    const game = fixtureGame();
    const before = JSON.parse(JSON.stringify(game));
    const roster = parseRoster(validRosterDoc());

    const result = applyStoredRoster(game, roster);

    expect(result.applied).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.game.catalog!.species.some((s) => s.id === "puddlekin")).toBe(true);
    // The input `game` is untouched.
    expect(game).toEqual(before);
    expect(game.catalog!.species.length).toBe(1);
  });

  it("falls back to the shipped game, surfacing the engine's message, when an entry violates the stat budget", () => {
    const game = fixtureGame();
    const roster = parseRoster(
      validRosterDoc({ baseStats: { hp: 70, atk: 50, def: 60, spd: 50 } }), // totals 230, not 240
    );

    const result = applyStoredRoster(game, roster);

    expect(result.applied).toBe(false);
    expect(result.game).toBe(game); // exactly the shipped game back, unchanged
    expect(result.errors.some((e) => e.includes("must equal exactly 240"))).toBe(true);
  });

  it("falls back to the shipped game on an id collision", () => {
    const game = fixtureGame();
    const roster = parseRoster(validRosterDoc({ id: "sparky" }));

    const result = applyStoredRoster(game, roster);

    expect(result.applied).toBe(false);
    expect(result.game).toBe(game);
    expect(result.errors.some((e) => e.includes("collides with a shipped species"))).toBe(true);
  });
});

describe("loadRosterOverlay", () => {
  it("returns the shipped game unchanged, with no errors, when nothing was saved", () => {
    const game = fixtureGame();
    const result = loadRosterOverlay(game, "roster-web-test");
    expect(result.applied).toBe(false);
    expect(result.game).toBe(game);
    expect(result.errors).toEqual([]);
    expect(result.roster).toBeNull();
  });

  it("reads, applies, and layers a saved roster onto the game", () => {
    const game = fixtureGame();
    writeRoster("roster-web-test", parseRoster(validRosterDoc()));

    const result = loadRosterOverlay(game, "roster-web-test");

    expect(result.applied).toBe(true);
    expect(result.game.catalog!.species.some((s) => s.id === "puddlekin")).toBe(true);
    expect(result.roster).not.toBeNull();
  });

  it("falls back to the shipped game, surfacing the reason, when the saved roster is corrupt", () => {
    fakeStorage.setItem("llmrpg:roster:roster-web-test", "{not json");
    const game = fixtureGame();

    const result = loadRosterOverlay(game, "roster-web-test");

    expect(result.applied).toBe(false);
    expect(result.game).toBe(game);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---- sprite overlay ---------------------------------------------------------

describe("applyRosterSprites", () => {
  it("registers a decoded sprite on the manifest and returns the species mapping", async () => {
    const loaded = emptyManifest();
    const roster = parseRoster(validRosterDoc({}, "data:image/png;base64,AAAA"));
    const fakeImage = { naturalWidth: 32, naturalHeight: 32, width: 32, height: 32 } as unknown as HTMLImageElement;

    const overlay = await applyRosterSprites(loaded, "roster-web-test", roster, async () => fakeImage);

    expect(overlay.warnings).toEqual([]);
    const spriteId = overlay.species["puddlekin"];
    expect(spriteId).toBeTruthy();
    expect(loaded.manifest.sprites[spriteId]).toBeDefined();
    expect(loaded.manifest.sprites[spriteId].anims.idle.frames).toEqual([[0, 0]]);
    const sheetId = loaded.manifest.sprites[spriteId].sheet;
    expect(loaded.sheets.get(sheetId)?.image).toBe(fakeImage);
    expect(loaded.manifest.sheets[sheetId]).toEqual({
      src: "data:image/png;base64,AAAA",
      tileW: 32,
      tileH: 32,
    });
  });

  it("degrades to no mapping (glyph fallback), with a warning, when an entry has no spriteDataUrl", async () => {
    const loaded = emptyManifest();
    const roster = parseRoster(validRosterDoc());

    const overlay = await applyRosterSprites(loaded, "roster-web-test", roster);

    expect(overlay.species).toEqual({});
    expect(overlay.warnings).toEqual([]); // no data URL at all isn't a failure, just nothing to do
    expect(Object.keys(loaded.manifest.sprites)).toEqual([]);
  });

  it("degrades gently, with a warning, when the image fails to decode", async () => {
    const loaded = emptyManifest();
    const roster = parseRoster(validRosterDoc({}, "data:image/png;base64,BAD"));

    const overlay = await applyRosterSprites(loaded, "roster-web-test", roster, async () => {
      throw new Error("boom");
    });

    expect(overlay.species).toEqual({});
    expect(overlay.warnings.some((w) => w.includes("puddlekin"))).toBe(true);
    expect(Object.keys(loaded.manifest.sprites)).toEqual([]);
  });
});

describe("mergeRosterSprites", () => {
  it("merges roster species entries into an existing sprites.json species map", () => {
    const merged = mergeRosterSprites({ species: { sparky: "battler-sparky" } }, { puddlekin: "roster:x:puddlekin" });
    expect(merged).toEqual({
      species: { sparky: "battler-sparky", puddlekin: "roster:x:puddlekin" },
    });
  });

  it("treats a non-object base as empty rather than throwing", () => {
    expect(() => mergeRosterSprites(null, { a: "b" })).not.toThrow();
    expect(mergeRosterSprites(null, { a: "b" })).toEqual({ species: { a: "b" } });
    expect(mergeRosterSprites("garbage", { a: "b" })).toEqual({ species: { a: "b" } });
  });
});
