import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addItem,
  addMove,
  addSpecies,
  addTile,
  addTrigger,
  applyOps,
  createGame,
  createMap,
  type ForgeResult,
  linkPortal,
  paintCells,
  paintRect,
  placeEntity,
  removeCatalog,
  removeEntity,
  removeItem,
  removeMove,
  removeSpecies,
  removeTile,
  removeTrigger,
  renderMapAscii,
  setDialogue,
  setEncounters,
  setMeta,
  setPlayerStart,
  setTriggers,
  setTypeChart,
  setVariants,
  updateEntity,
  updateSpecies,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Unwrap a result that must have succeeded, failing loudly otherwise. */
function ok(result: ForgeResult): unknown {
  expect(result.opErrors).toEqual([]);
  expect(result.ok).toBe(true);
  return result.doc;
}

/** Assert a rejection: ok false, doc returned as the SAME unchanged object. */
function rejected(result: ForgeResult, doc: unknown, ...fragments: string[]): void {
  expect(result.ok).toBe(false);
  expect(result.doc).toBe(doc);
  expect(result.opErrors.length).toBeGreaterThan(0);
  const all = result.opErrors.join("\n");
  for (const f of fragments) expect(all).toContain(f);
}

/** The canonical pipeline: a small but fully valid two-map game. */
function buildVillageDraft(): unknown {
  let doc = ok(createGame({ id: "test-isle", title: "Test Isle", goal: "Reach the meadow." }));
  doc = ok(setTypeChart(doc, { types: ["normal"], effectiveness: {} }));
  doc = ok(
    addMove(doc, {
      move: { id: "bonk", name: "Bonk", type: "normal", category: "physical", power: 40, accuracy: 1, pp: 35 },
    }),
  );
  doc = ok(
    addSpecies(doc, {
      species: {
        id: "fluffit",
        name: "Fluffit",
        glyph: "🐹",
        types: ["normal"],
        baseStats: { hp: 50, atk: 45, def: 40, spd: 55 },
        learnset: [{ level: 1, moveId: "bonk" }],
        catchRate: 0.5,
        xpYield: 45,
      },
    }),
  );
  doc = ok(addItem(doc, { item: { id: "salve", name: "Salve", kind: "heal", amount: 20, price: 10 } }));
  doc = ok(createMap(doc, { mapId: "village", width: 8, height: 6, fill: "." }));
  doc = ok(paintRect(doc, { mapId: "village", x1: 0, y1: 0, x2: 7, y2: 0, char: "#" }));
  doc = ok(paintRect(doc, { mapId: "village", x1: 0, y1: 5, x2: 7, y2: 5, char: "#" }));
  doc = ok(paintRect(doc, { mapId: "village", x1: 0, y1: 0, x2: 0, y2: 5, char: "#" }));
  doc = ok(paintRect(doc, { mapId: "village", x1: 7, y1: 0, x2: 7, y2: 5, char: "#" }));
  doc = ok(createMap(doc, { mapId: "meadow", width: 6, height: 5, fill: "." }));
  doc = ok(
    paintCells(doc, {
      mapId: "meadow",
      cells: [
        { x: 3, y: 2, char: "*" },
        { x: 4, y: 2, char: "*" },
      ],
    }),
  );
  doc = ok(
    setEncounters(doc, {
      mapId: "meadow",
      zone: { rate: 0.2, table: [{ speciesId: "fluffit", minLevel: 2, maxLevel: 4, weight: 1 }] },
    }),
  );
  doc = ok(
    placeEntity(doc, {
      mapId: "village",
      entity: {
        id: "elder",
        name: "Elder",
        glyph: "🧙",
        x: 2,
        y: 2,
        interactions: [{ commands: [{ type: "say", text: "Welcome." }] }],
      },
    }),
  );
  doc = ok(
    linkPortal(doc, {
      from: { mapId: "village", x: 6, y: 4 },
      to: { mapId: "meadow", x: 1, y: 1 },
      bidirectional: true,
    }),
  );
  doc = ok(
    setPlayerStart(doc, {
      mapId: "village",
      x: 1,
      y: 1,
      party: [{ speciesId: "fluffit", level: 5 }],
      money: 50,
      inventory: [{ itemId: "salve", qty: 2 }],
      respawn: { map: "village", x: 1, y: 1 },
    }),
  );
  return doc;
}

describe("createGame", () => {
  it("makes a minimal draft with starter legend tiles, in schema key order", () => {
    const result = createGame({ id: "g", title: "G", goal: "Win." });
    const doc = ok(result) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["meta", "catalog", "legend", "maps", "player"]);
    const legend = doc.legend as Record<string, { walkable: boolean; wild?: boolean }>;
    expect(Object.keys(legend)).toEqual([".", "#", ",", "~", "*"]);
    expect(legend["*"].wild).toBe(true);
    expect(legend["#"].walkable).toBe(false);
    // A fresh draft is a valid draft but NOT yet a valid game — advisory only.
    expect(result.validation.ok).toBe(false);
  });

  it("rejects empty meta fields with the field named", () => {
    const result = createGame({ id: "", title: "T", goal: "G" });
    expect(result.ok).toBe(false);
    expect(result.opErrors.join("\n")).toContain("createGame.id");
  });
});

describe("the full authoring pipeline", () => {
  it("createGame → catalog → maps → paint → entity → portal → player start ends fully valid", () => {
    const doc = buildVillageDraft();
    const result = setEncounters(doc, { mapId: "meadow", zone: null });
    // Re-run any op just to read advisory validation of the finished draft.
    const finished = setEncounters(result.doc, {
      mapId: "meadow",
      zone: { rate: 0.2, table: [{ speciesId: "fluffit", minLevel: 2, maxLevel: 4, weight: 1 }] },
    });
    expect(finished.validation.errors).toEqual([]);
    expect(finished.validation.ok).toBe(true);
  });

  it("the built draft itself validates clean", () => {
    const doc = buildVillageDraft();
    // The last pipeline op already returned validation; check independently.
    const probe = setPlayerStart(doc, { mapId: "village", x: 1, y: 1 });
    expect(probe.validation.errors).toEqual([]);
    expect(probe.validation.ok).toBe(true);
  });
});

describe("createMap", () => {
  it("fills width x height with the fill char and no auto borders", () => {
    const base = ok(createGame({ id: "g", title: "G", goal: "Win." }));
    const doc = ok(createMap(base, { mapId: "m", width: 4, height: 3, fill: "." })) as any;
    expect(doc.maps.m.rows).toEqual(["....", "....", "...."]);
    expect(doc.maps.m.entities).toEqual([]);
    expect(doc.maps.m.portals).toEqual([]);
  });

  it("rejects a duplicate mapId", () => {
    const doc = buildVillageDraft();
    rejected(createMap(doc, { mapId: "village", width: 4, height: 4, fill: "." }), doc, "already exists");
  });

  it("rejects a fill char that is not in the legend", () => {
    const doc = buildVillageDraft();
    rejected(createMap(doc, { mapId: "cave", width: 4, height: 4, fill: "%" }), doc, "not in the legend", "addTile");
  });

  it("rejects non-positive dimensions", () => {
    const doc = buildVillageDraft();
    rejected(createMap(doc, { mapId: "cave", width: 0, height: 4, fill: "." }), doc, "width");
  });
});

describe("paintRect / paintCells", () => {
  it("paints an inclusive rect, corners in any order", () => {
    const base = ok(createGame({ id: "g", title: "G", goal: "Win." }));
    const withMap = ok(createMap(base, { mapId: "m", width: 5, height: 4, fill: "." }));
    const a = ok(paintRect(withMap, { mapId: "m", x1: 1, y1: 1, x2: 3, y2: 2, char: "#" })) as any;
    const b = ok(paintRect(withMap, { mapId: "m", x1: 3, y1: 2, x2: 1, y2: 1, char: "#" })) as any;
    expect(a.maps.m.rows).toEqual([".....", ".###.", ".###.", "....."]);
    expect(b.maps.m.rows).toEqual(a.maps.m.rows);
  });

  it("rejects an unknown map, naming the known ones", () => {
    const doc = buildVillageDraft();
    rejected(
      paintRect(doc, { mapId: "nowhere", x1: 0, y1: 0, x2: 1, y2: 1, char: "#" }),
      doc,
      'unknown map "nowhere"',
      "village",
    );
  });

  it("rejects out-of-bounds paints", () => {
    const doc = buildVillageDraft();
    rejected(paintRect(doc, { mapId: "village", x1: 0, y1: 0, x2: 99, y2: 1, char: "#" }), doc, "outside map");
  });

  it("rejects a char missing from the legend", () => {
    const doc = buildVillageDraft();
    rejected(paintRect(doc, { mapId: "village", x1: 1, y1: 1, x2: 2, y2: 2, char: "%" }), doc, "not in the legend");
  });

  it("paintCells rejects any bad cell by index, painting nothing", () => {
    const doc = buildVillageDraft();
    const result = paintCells(doc, {
      mapId: "village",
      cells: [
        { x: 1, y: 1, char: "." },
        { x: 50, y: 1, char: "." },
      ],
    });
    rejected(result, doc, "cells[1]", "outside map");
  });

  it("never mutates the input doc", () => {
    const doc = buildVillageDraft();
    const before = JSON.stringify(doc);
    const result = paintRect(doc, { mapId: "village", x1: 1, y1: 1, x2: 2, y2: 2, char: "*" });
    expect(result.ok).toBe(true);
    expect(result.doc).not.toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("addTile / removeTile", () => {
  it("adds a tile (defaults filled) and rejects duplicates and multi-char keys", () => {
    const doc = buildVillageDraft();
    const added = ok(addTile(doc, { char: "=", tile: { name: "floor", glyph: "🟫", walkable: true } })) as any;
    expect(added.legend["="]).toEqual({ name: "floor", glyph: "🟫", walkable: true, wild: false });
    rejected(addTile(doc, { char: ".", tile: { name: "x", glyph: "x", walkable: true } }), doc, 'already has "."');
    rejected(addTile(doc, { char: "ab", tile: { name: "x", glyph: "x", walkable: true } }), doc, "exactly one character");
  });

  it("refuses to remove a tile still painted on a map, naming where", () => {
    const doc = buildVillageDraft();
    rejected(removeTile(doc, { char: "#" }), doc, "still painted", "maps.village");
  });

  it("removes an unused tile and rejects unknown chars", () => {
    const doc = buildVillageDraft();
    const gone = ok(removeTile(doc, { char: "~" })) as any; // water was never painted
    expect("~" in gone.legend).toBe(false);
    rejected(removeTile(doc, { char: "%" }), doc, "not in the legend");
  });
});

describe("placeEntity / updateEntity / removeEntity", () => {
  it("rejects an unknown map and duplicate entity ids across maps", () => {
    const doc = buildVillageDraft();
    const entity = { id: "elder", name: "Copy", glyph: "x", x: 3, y: 3 };
    rejected(placeEntity(doc, { mapId: "nowhere", entity }), doc, 'unknown map "nowhere"');
    rejected(placeEntity(doc, { mapId: "meadow", entity }), doc, 'entity id "elder" is already used on map "village"');
  });

  it("fills entity defaults on placement", () => {
    const doc = buildVillageDraft();
    const placed = ok(
      placeEntity(doc, { mapId: "meadow", entity: { id: "dog", name: "Dog", glyph: "🐕", x: 2, y: 3 } }),
    ) as any;
    const dog = placed.maps.meadow.entities.find((e: any) => e.id === "dog");
    expect(dog.blocking).toBe(true);
    expect(dog.interactions).toEqual([]);
  });

  it("updateEntity shallow-merges a patch and can move maps via patch.mapId", () => {
    const doc = buildVillageDraft();
    const moved = ok(updateEntity(doc, { entityId: "elder", patch: { mapId: "meadow", x: 2, y: 3, name: "Wanderer" } })) as any;
    expect(moved.maps.village.entities).toEqual([]);
    const elder = moved.maps.meadow.entities.find((e: any) => e.id === "elder");
    expect(elder.name).toBe("Wanderer");
    expect(elder.x).toBe(2);
    expect(elder.glyph).toBe("🧙"); // untouched field survives the merge
  });

  it("rejects unknown entities, bad patches, and renames onto a taken id", () => {
    const doc = buildVillageDraft();
    rejected(updateEntity(doc, { entityId: "ghost", patch: { x: 1 } }), doc, 'unknown entity "ghost"', "elder");
    rejected(updateEntity(doc, { entityId: "elder", patch: { x: -1 } }), doc, "updateEntity");
    rejected(updateEntity(doc, { entityId: "elder", patch: { dialog: [] } }), doc, "updateEntity.patch");
    const two = ok(placeEntity(doc, { mapId: "meadow", entity: { id: "dog", name: "Dog", glyph: "🐕", x: 2, y: 3 } }));
    rejected(updateEntity(two, { entityId: "dog", patch: { id: "elder" } }), two, "already used");
    rejected(updateEntity(doc, { entityId: "elder", patch: { mapId: "nowhere" } }), doc, 'unknown map "nowhere"');
  });

  it("removeEntity removes, and rejects unknown ids", () => {
    const doc = buildVillageDraft();
    const gone = ok(removeEntity(doc, { entityId: "elder" })) as any;
    expect(gone.maps.village.entities).toEqual([]);
    rejected(removeEntity(doc, { entityId: "ghost" }), doc, 'unknown entity "ghost"');
  });
});

describe("setDialogue", () => {
  it("replaces the interactions array wholesale", () => {
    const doc = buildVillageDraft();
    const updated = ok(
      setDialogue(doc, {
        entityId: "elder",
        interactions: [
          { requiresFlag: "met", commands: [{ type: "say", text: "Again!" }] },
          { commands: [{ type: "say", text: "Hello." }, { type: "set_flag", flag: "met" }] },
        ],
      }),
    ) as any;
    const elder = updated.maps.village.entities[0];
    expect(elder.interactions).toHaveLength(2);
    expect(elder.interactions[0].requiresFlag).toBe("met");
  });

  it("rejects unknown entities and structurally bad interactions", () => {
    const doc = buildVillageDraft();
    rejected(setDialogue(doc, { entityId: "ghost", interactions: [] }), doc, 'unknown entity "ghost"');
    rejected(
      setDialogue(doc, { entityId: "elder", interactions: [{ commands: [] }] as never }),
      doc,
      "setDialogue.interactions",
    );
  });
});

describe("linkPortal", () => {
  it("a dangling portal to a not-yet-created map is storable: ok true, validation not ok", () => {
    const doc = buildVillageDraft();
    const result = linkPortal(doc, { from: { mapId: "village", x: 5, y: 4 }, to: { mapId: "cave", x: 1, y: 1 } });
    expect(result.opErrors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors.join("\n")).toContain("cave");
  });

  it("replaces any existing portal on the source tile", () => {
    const doc = buildVillageDraft();
    const relinked = ok(
      linkPortal(doc, { from: { mapId: "village", x: 6, y: 4 }, to: { mapId: "meadow", x: 2, y: 2 } }),
    ) as any;
    const portals = relinked.maps.village.portals.filter((p: any) => p.x === 6 && p.y === 4);
    expect(portals).toEqual([{ x: 6, y: 4, toMap: "meadow", toX: 2, toY: 2 }]);
  });

  it("bidirectional links both ways, and needs the target map to exist", () => {
    const doc = buildVillageDraft();
    const back = (doc as any).maps.meadow.portals;
    expect(back).toEqual([{ x: 1, y: 1, toMap: "village", toX: 6, toY: 4 }]);
    rejected(
      linkPortal(doc, { from: { mapId: "village", x: 5, y: 4 }, to: { mapId: "cave", x: 1, y: 1 }, bidirectional: true }),
      doc,
      'needs map "cave" to exist',
    );
    rejected(linkPortal(doc, { from: { mapId: "cave", x: 0, y: 0 }, to: { mapId: "village", x: 1, y: 1 } }), doc, 'unknown map "cave"');
  });
});

describe("setEncounters", () => {
  it("sets and clears (zone: null) a map's encounter zone", () => {
    const doc = buildVillageDraft();
    const cleared = ok(setEncounters(doc, { mapId: "meadow", zone: null })) as any;
    expect("encounters" in cleared.maps.meadow).toBe(false);
    // Clearing while wild tiles remain is a draft state, flagged as advisory.
    const probe = setEncounters(cleared, { mapId: "meadow", zone: null });
    expect(probe.validation.ok).toBe(false);
  });

  it("rejects unknown maps and malformed zones", () => {
    const doc = buildVillageDraft();
    rejected(setEncounters(doc, { mapId: "nowhere", zone: null }), doc, 'unknown map "nowhere"');
    rejected(
      setEncounters(doc, { mapId: "meadow", zone: { rate: 2, table: [] } as never }),
      doc,
      "setEncounters.zone",
    );
  });
});

describe("setPlayerStart", () => {
  it("builds the player in schema key order and keeps omitted fields", () => {
    const doc = buildVillageDraft();
    const moved = ok(setPlayerStart(doc, { mapId: "meadow", x: 2, y: 2 })) as any;
    expect(Object.keys(moved.player)).toEqual(["glyph", "map", "x", "y", "party", "money", "inventory", "respawn"]);
    expect(moved.player.map).toBe("meadow");
    expect(moved.player.money).toBe(50); // kept from the earlier setPlayerStart
    expect(moved.player.party).toEqual([{ speciesId: "fluffit", level: 5 }]);
  });

  it("rejects an unknown map", () => {
    const doc = buildVillageDraft();
    rejected(setPlayerStart(doc, { mapId: "nowhere", x: 0, y: 0 }), doc, 'unknown map "nowhere"');
  });
});

describe("catalog ops", () => {
  it("add rejects duplicate ids; update merges; unknown ids are named", () => {
    const doc = buildVillageDraft();
    rejected(
      addSpecies(doc, { species: (doc as any).catalog.species[0] }),
      doc,
      'species id "fluffit" already exists',
    );
    const tweaked = ok(updateSpecies(doc, { speciesId: "fluffit", patch: { catchRate: 0.9 } })) as any;
    expect(tweaked.catalog.species[0].catchRate).toBe(0.9);
    expect(tweaked.catalog.species[0].name).toBe("Fluffit");
    rejected(updateSpecies(doc, { speciesId: "nobody", patch: { catchRate: 0.9 } }), doc, 'unknown species "nobody"', "fluffit");
  });

  it("remove refuses while referenced, naming every reference", () => {
    const doc = buildVillageDraft();
    const r = removeSpecies(doc, { speciesId: "fluffit" });
    rejected(r, doc, "still referenced", "player.party[0]", "maps.meadow.encounters.table[0]");
    rejected(removeMove(doc, { moveId: "bonk" }), doc, "catalog.species.fluffit.learnset[0]");
    rejected(removeItem(doc, { itemId: "salve" }), doc, "player.inventory[0]");
  });

  it("remove succeeds once nothing references the entry", () => {
    let doc = buildVillageDraft();
    doc = ok(
      addMove(doc, { move: { id: "zap", name: "Zap", type: "normal", power: 30, accuracy: 1, pp: 20 } }),
    );
    const removed = ok(removeMove(doc, { moveId: "zap" })) as any;
    expect(removed.catalog.moves.map((m: any) => m.id)).toEqual(["bonk"]);
  });

  it("setTypeChart replaces the chart and rejects an empty types list", () => {
    const doc = buildVillageDraft();
    const swapped = ok(
      setTypeChart(doc, { types: ["normal", "fire"], effectiveness: { fire: { fire: 0.5 } } }),
    ) as any;
    expect(swapped.catalog.typeChart.types).toEqual(["normal", "fire"]);
    rejected(setTypeChart(doc, { types: [], effectiveness: {} }), doc, "setTypeChart.types");
  });
});

describe("key-order stability (emberwood fixture, read-only)", () => {
  const raw = readFileSync(join(ROOT, "games/emberwood/game.json"), "utf8");

  it("a one-cell paint diffs exactly one line of the pretty-printed document", () => {
    const orig = JSON.parse(raw) as any;
    const mapId = Object.keys(orig.maps)[0];
    const current = [...orig.maps[mapId].rows[1]][1];
    const char = Object.keys(orig.legend).find((c) => c !== current)!;
    const result = paintCells(orig, { mapId, cells: [{ x: 1, y: 1, char }] });
    expect(result.opErrors).toEqual([]);
    expect(result.ok).toBe(true);
    const before = JSON.stringify(orig, null, 2).split("\n");
    const after = JSON.stringify(result.doc, null, 2).split("\n");
    expect(after.length).toBe(before.length);
    const diffs = before.flatMap((line, i) => (line === after[i] ? [] : [i]));
    expect(diffs).toHaveLength(1);
    expect(after[diffs[0]]).toContain(char);
    // The fixture itself was never mutated.
    expect(JSON.stringify(orig)).toBe(JSON.stringify(JSON.parse(raw)));
  });

  it("top-level and per-map key order survive an entity edit", () => {
    const orig = JSON.parse(raw) as any;
    const mapId = Object.keys(orig.maps).find((m) => orig.maps[m].entities.length > 0)!;
    const entityId = orig.maps[mapId].entities[0].id;
    const result = setDialogue(orig, {
      entityId,
      interactions: [{ commands: [{ type: "say", text: "Edited." }] }],
    });
    const doc = ok(result) as any;
    expect(Object.keys(doc)).toEqual(Object.keys(orig));
    expect(Object.keys(doc.maps)).toEqual(Object.keys(orig.maps));
    expect(Object.keys(doc.maps[mapId])).toEqual(Object.keys(orig.maps[mapId]));
    expect(Object.keys(doc.catalog)).toEqual(Object.keys(orig.catalog));
  });
});

describe("applyOps", () => {
  it("runs a batch sequentially to a finished doc", () => {
    const result = applyOps(undefined, [
      { op: "createGame", args: { id: "b", title: "B", goal: "Win." } },
      { op: "createMap", args: { mapId: "m", width: 4, height: 3, fill: "." } },
      { op: "paintRect", args: { mapId: "m", x1: 0, y1: 0, x2: 3, y2: 0, char: "#" } },
    ]);
    expect(result.opErrors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.failedIndex).toBeNull();
    expect((result.doc as any).maps.m.rows[0]).toBe("####");
  });

  it("stops at the first rejection and reports its index, keeping prior ops", () => {
    const result = applyOps(undefined, [
      { op: "createGame", args: { id: "b", title: "B", goal: "Win." } },
      { op: "createMap", args: { mapId: "m", width: 4, height: 3, fill: "." } },
      { op: "paintRect", args: { mapId: "nowhere", x1: 0, y1: 0, x2: 1, y2: 1, char: "#" } },
      { op: "createMap", args: { mapId: "never-made", width: 2, height: 2, fill: "." } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failedIndex).toBe(2);
    expect(result.opErrors[0]).toContain("ops[2] (paintRect)");
    expect((result.doc as any).maps.m).toBeDefined(); // ops 0-1 applied
    expect((result.doc as any).maps["never-made"]).toBeUndefined(); // op 3 never ran
  });

  it("rejects unknown op names, listing the registry", () => {
    const result = applyOps(undefined, [{ op: "conjureMap", args: {} }]);
    expect(result.ok).toBe(false);
    expect(result.failedIndex).toBe(0);
    expect(result.opErrors[0]).toContain('unknown op "conjureMap"');
    expect(result.opErrors[0]).toContain("createMap");
  });
});

describe("renderMapAscii", () => {
  it("draws the grid with entity, portal, and player overlays plus a key", () => {
    const doc = buildVillageDraft();
    const text = renderMapAscii(doc, "village");
    const lines = text.split("\n");
    expect(lines[0]).toBe("village — 8x6");
    expect(lines[1]).toBe("########");
    expect(lines[2]).toBe("#@.....#");
    expect(lines[3]).toBe("#.🧙....#");
    expect(lines[5]).toBe("#.....⇄#");
    expect(text).toContain('🧙 elder "Elder" at (2, 2)');
    expect(text).toContain("⇄ (6, 4) -> meadow (1, 1)");
    expect(text).toContain("Player start: @ (1, 1)");
  });

  it("shows encounters and flags portals to missing maps", () => {
    const doc = buildVillageDraft();
    const meadow = renderMapAscii(doc, "meadow");
    expect(meadow).toContain("Encounters: rate 0.2 — fluffit Lv2-4 (w1)");
    const dangling = linkPortal(doc, { from: { mapId: "meadow", x: 4, y: 3 }, to: { mapId: "cave", x: 0, y: 0 } });
    expect(renderMapAscii(dangling.doc, "meadow")).toContain("cave (0, 0) [map does not exist yet]");
  });

  it("explains an unknown map instead of throwing", () => {
    const doc = buildVillageDraft();
    expect(renderMapAscii(doc, "nowhere")).toContain('unknown map "nowhere"');
    expect(renderMapAscii(doc, "nowhere")).toContain("village");
    expect(renderMapAscii(null, "x")).toContain("no maps to render");
  });
});

// ---------------------------------------------------------------------------
// Narrative ops (djt.8): setMeta, triggers, variants, removeCatalog
// ---------------------------------------------------------------------------

describe("setMeta", () => {
  it("shallow-merges meta fields, keeping the rest", () => {
    const doc = buildVillageDraft();
    const edited = ok(setMeta(doc, { goal: "Reach the far meadow.", version: "0.2.0" })) as any;
    expect(edited.meta).toEqual({
      id: "test-isle",
      title: "Test Isle",
      version: "0.2.0",
      goal: "Reach the far meadow.",
    });
    // Top-level key order survives.
    expect(Object.keys(edited)).toEqual(["meta", "catalog", "legend", "maps", "player"]);
  });

  it("rejects an empty patch and unknown keys", () => {
    const doc = buildVillageDraft();
    rejected(setMeta(doc, {}), doc, "at least one of id, title, goal, version");
    rejected(setMeta(doc, { subtitle: "x" } as never), doc, "setMeta");
  });
});

describe("setTriggers / addTrigger / removeTrigger", () => {
  const trigger = (id: string) => ({
    id,
    on: "enter" as const,
    commands: [{ type: "say" as const, text: "The wind shifts." }],
  });

  it("setTriggers replaces the list, [] clears it, duplicate ids are rejected", () => {
    const doc = buildVillageDraft();
    const withTriggers = ok(
      setTriggers(doc, { mapId: "village", triggers: [trigger("arrival"), trigger("omen")] }),
    ) as any;
    expect(withTriggers.maps.village.triggers.map((t: any) => t.id)).toEqual(["arrival", "omen"]);
    expect(withTriggers.maps.village.triggers[0].once).toBe(true); // default filled
    const cleared = ok(setTriggers(withTriggers, { mapId: "village", triggers: [] })) as any;
    expect(cleared.maps.village.triggers).toBeUndefined();
    rejected(
      setTriggers(doc, { mapId: "village", triggers: [trigger("a"), trigger("a")] }),
      doc,
      'duplicate trigger id "a"',
    );
    rejected(setTriggers(doc, { mapId: "nowhere", triggers: [] }), doc, 'unknown map "nowhere"');
  });

  it("addTrigger appends and rejects a duplicate id on the same map", () => {
    let doc = ok(addTrigger(buildVillageDraft(), { mapId: "village", trigger: trigger("arrival") }));
    doc = ok(
      addTrigger(doc, {
        mapId: "village",
        trigger: { ...trigger("step-omen"), on: "step", tiles: [{ x: 2, y: 3 }] },
      }),
    );
    expect((doc as any).maps.village.triggers.map((t: any) => t.id)).toEqual([
      "arrival",
      "step-omen",
    ]);
    rejected(
      addTrigger(doc, { mapId: "village", trigger: trigger("arrival") }),
      doc,
      'trigger id "arrival" already exists',
    );
  });

  it("removeTrigger removes by id and names the known ids on a miss", () => {
    const doc = ok(addTrigger(buildVillageDraft(), { mapId: "village", trigger: trigger("arrival") }));
    const removed = ok(removeTrigger(doc, { mapId: "village", triggerId: "arrival" })) as any;
    expect(removed.maps.village.triggers).toBeUndefined();
    rejected(
      removeTrigger(doc, { mapId: "village", triggerId: "nope" }),
      doc,
      'no trigger "nope"',
      "arrival",
    );
  });

  it("trigger bodies are advisory-validated: a bad command ref shows in validation, not opErrors", () => {
    const doc = buildVillageDraft();
    const result = setTriggers(doc, {
      mapId: "village",
      triggers: [
        {
          id: "gift",
          on: "enter",
          commands: [{ type: "give_species", speciesId: "no-such-species", level: 3 }],
        },
      ],
    });
    expect(result.ok).toBe(true); // the op is well-formed
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors.join("\n")).toContain("no-such-species");
  });
});

describe("setVariants", () => {
  it("replaces an entity's variants, [] clears them, duplicates and unknown entities reject", () => {
    const doc = buildVillageDraft();
    const withVariants = ok(
      setVariants(doc, {
        entityId: "elder",
        variants: [
          { id: "hooded", when: { flag: "night" }, glyph: "🥷", name: "Hooded Figure" },
          { id: "plain" },
        ],
      }),
    ) as any;
    const elder = withVariants.maps.village.entities.find((e: any) => e.id === "elder");
    expect(elder.variants.map((v: any) => v.id)).toEqual(["hooded", "plain"]);
    const cleared = ok(setVariants(withVariants, { entityId: "elder", variants: [] })) as any;
    expect(
      cleared.maps.village.entities.find((e: any) => e.id === "elder").variants,
    ).toBeUndefined();
    rejected(
      setVariants(doc, { entityId: "elder", variants: [{ id: "x" }, { id: "x" }] }),
      doc,
      'duplicate variant id "x"',
    );
    rejected(setVariants(doc, { entityId: "ghost", variants: [] }), doc, 'unknown entity "ghost"');
  });
});

describe("removeCatalog and the catalog-free narrative pipeline", () => {
  it("refuses while the catalog still has moves/species/items, naming the counts", () => {
    const doc = buildVillageDraft();
    rejected(removeCatalog(doc), doc, "still defines", "moves", "species", "items");
  });

  it("deletes an empty catalog; a second call explains the draft is already narrative", () => {
    const doc = ok(createGame({ id: "story", title: "Story", goal: "Reach the end." }));
    const bare = ok(removeCatalog(doc)) as any;
    expect(bare.catalog).toBeUndefined();
    rejected(removeCatalog(bare), bare, "no catalog");
  });

  it("builds a fully valid catalog-free narrative game with choice/passage/when/end dialogue and variants", () => {
    let doc = ok(createGame({ id: "vignette", title: "Vignette", goal: "Hear the ferryman out." }));
    doc = ok(removeCatalog(doc));
    doc = ok(createMap(doc, { mapId: "shore", width: 6, height: 5, fill: "." }));
    doc = ok(paintRect(doc, { mapId: "shore", x1: 0, y1: 0, x2: 5, y2: 0, char: "#" }));
    // placeEntity accepts the narrative schema fields: variants + sprite.
    doc = ok(
      placeEntity(doc, {
        mapId: "shore",
        entity: {
          id: "ferryman",
          name: "Ferryman",
          glyph: "🧍",
          x: 3,
          y: 2,
          sprite: "ferryman",
          variants: [{ id: "paid", when: { flag: "fare_paid" }, name: "Smiling Ferryman" }],
          interactions: [],
        },
      }),
    );
    // setDialogue accepts choice / passage / when-gated commands / end.
    doc = ok(
      setDialogue(doc, {
        entityId: "ferryman",
        interactions: [
          {
            when: { flag: "fare_paid" },
            commands: [{ type: "end", id: "crossing", text: "The boat slips from the shore." }],
          },
          {
            commands: [
              {
                type: "passage",
                title: "The Shore",
                lines: ["Grey water, grey sky.", "The ferryman waits."],
              },
              {
                type: "choice",
                prompt: "Pay the fare?",
                options: [
                  { label: "Pay", commands: [{ type: "set_flag", flag: "fare_paid" }] },
                  { label: "Walk away", commands: [{ type: "say", text: "Suit yourself." }] },
                ],
              },
              { type: "say", text: "Well?", when: { notFlag: "fare_paid" } },
            ],
          },
        ],
      }),
    );
    const result = setPlayerStart(doc, { mapId: "shore", x: 1, y: 1 });
    expect(result.opErrors).toEqual([]);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.warnings).toEqual([]);
    expect(result.validation.ok).toBe(true);
    expect(result.validation.endings).toEqual(["crossing"]);
  });
});
