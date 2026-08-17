import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateGame, ROSTER_STAT_BUDGET, type Game, type Roster } from "@llm-rpg/engine";
import {
  GLYPHS,
  HUES,
  MAX_MOVES,
  STAT_STEP,
  adjustRow,
  adjustStat,
  buildEntry,
  buildRows,
  draftProblems,
  freeBodies,
  freshDraft,
  moveCandidates,
  releaseMapId,
  remainingPoints,
  slugifyId,
  takenIds,
  toggleMove,
  typeOptions,
} from "./studio";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function loadGame(): Game {
  const r = validateGame(JSON.parse(readFileSync(`${ROOT}games/emberwood/game.json`, "utf8")));
  expect(r.errors).toEqual([]);
  return r.game!;
}

const game = loadGame();
const types = typeOptions(game);

/** A draft that would actually save: named, budget spent, one move. */
function validDraft() {
  const d = freshDraft("grass");
  return { ...d, name: "Clarkosaur", moves: [moveCandidates(game, "grass")[0].id] };
}

describe("the stat budget", () => {
  it("starts fully spent, so a child edits rather than starts from zero", () => {
    expect(remainingPoints(freshDraft("grass"))).toBe(0);
    expect(ROSTER_STAT_BUDGET).toBe(240);
  });

  it("refuses to raise past the budget instead of stealing from another stat", () => {
    const d = freshDraft("grass"); // 60/60/60/60, nothing spare
    expect(adjustStat(d, "atk", STAT_STEP)).toBe(d); // same object: no change
  });

  it("frees points when one stat drops, and lets another take them", () => {
    let d = adjustStat(freshDraft("grass"), "def", -STAT_STEP);
    expect(remainingPoints(d)).toBe(STAT_STEP);
    d = adjustStat(d, "spd", STAT_STEP);
    expect(remainingPoints(d)).toBe(0);
    expect(d.spd).toBe(65);
    expect(d.def).toBe(55);
  });

  it("keeps every stat above a floor, so nothing is a zero", () => {
    let d = freshDraft("grass");
    for (let i = 0; i < 40; i++) d = adjustStat(d, "hp", -STAT_STEP);
    expect(d.hp).toBeGreaterThan(0);
  });
});

describe("ids", () => {
  it("slugifies a child's spelling without complaint", () => {
    expect(slugifyId("Mr Fluffy!! 2", [])).toBe("mr-fluffy-2");
  });

  it("never collides with a shipped species", () => {
    const taken = game.catalog!.species.map((s) => s.id);
    expect(taken).toContain("emberling");
    expect(slugifyId("Emberling", taken)).not.toBe("emberling");
  });

  it("falls back to something usable when the name has no letters", () => {
    expect(slugifyId("!!!", [])).toBe("kindred");
  });
});

describe("choices are drawn from the target game", () => {
  it("offers only real types", () => {
    expect(types).toContain("grass");
    expect(types).toContain("psychic"); // added when Clark named Flufflehup's type
  });

  it("offers only real damaging moves of the chosen type or normal", () => {
    const ids = new Set(game.catalog!.moves.map((m) => m.id));
    for (const t of types) {
      for (const m of moveCandidates(game, t)) {
        expect(ids.has(m.id)).toBe(true);
        const move = game.catalog!.moves.find((x) => x.id === m.id)!;
        expect(move.type === t || move.type === "normal").toBe(true);
        expect(move.power).toBeGreaterThan(0);
      }
    }
  });

  it("releases into the Paddock, the map authored for exactly this", () => {
    expect(releaseMapId(game)).toBe("the-paddock");
  });

  it("changing type clears moves, because they belonged to the old one", () => {
    const d = { ...freshDraft("grass"), moves: ["leaflash"] };
    const next = adjustRow(d, { kind: "type" }, 1, 3, types);
    expect(next.type).not.toBe("grass");
    expect(next.moves).toEqual([]);
  });

  it("caps the moveset and toggles cleanly", () => {
    let d = freshDraft("normal");
    const candidates = moveCandidates(game, "normal");
    for (const c of candidates) d = toggleMove(d, c.id);
    expect(d.moves.length).toBe(Math.min(MAX_MOVES, candidates.length));
    const first = d.moves[0];
    d = toggleMove(d, first);
    expect(d.moves).not.toContain(first);
  });

  it("cycles bodies, colours and badges without running off the end", () => {
    let d = freshDraft("grass");
    for (let i = 0; i < 30; i++) d = adjustRow(d, { kind: "colour" }, 1, 5, types);
    expect(d.hueIndex).toBeGreaterThanOrEqual(0);
    expect(d.hueIndex).toBeLessThan(HUES.length);
    for (let i = 0; i < 30; i++) d = adjustRow(d, { kind: "glyph" }, -1, 5, types);
    expect(GLYPHS).toContain(d.glyph);
    for (let i = 0; i < 30; i++) d = adjustRow(d, { kind: "body" }, 1, 4, types);
    expect(d.bodyIndex).toBeGreaterThanOrEqual(0);
    expect(d.bodyIndex).toBeLessThan(4);
  });

  it("does not divide by zero when a game offers no spare bodies", () => {
    const d = freshDraft("grass");
    expect(adjustRow(d, { kind: "body" }, 1, 0, types)).toBe(d);
  });
});

describe("what stops a save", () => {
  it("asks for a name first, in words a child can act on", () => {
    const problems = draftProblems(game, freshDraft("grass"), null);
    expect(problems[0]).toBe("Give it a name.");
  });

  it("asks for a move when none is picked", () => {
    const d = { ...freshDraft("grass"), name: "Bud" };
    expect(draftProblems(game, d, null)).toContain("Pick at least one move.");
  });

  it("counts unspent points", () => {
    const d = { ...validDraft(), def: 55 }; // 5 short
    expect(draftProblems(game, d, null).join(" ")).toContain("Spend 5 more point");
  });

  it("passes a complete draft, and the engine agrees", () => {
    expect(draftProblems(game, validDraft(), null)).toEqual([]);
  });

  it("is the engine's verdict, not a second opinion: the built entry validates", () => {
    const entry = buildEntry(validDraft(), { id: "clarkosaur", mapId: "the-paddock" });
    expect(entry.baseStats.hp + entry.baseStats.atk + entry.baseStats.def + entry.baseStats.spd)
      .toBe(ROSTER_STAT_BUDGET);
    expect(entry.types).toEqual(["grass"]);
    expect(entry.location.mapId).toBe("the-paddock");
  });

  it("accounts for creatures already saved, so the second one is checked too", () => {
    const existing: Roster = {
      version: 1,
      entries: [buildEntry(validDraft(), { id: "clarkosaur", mapId: "the-paddock" })],
    };
    // Same name again: the id must be auto-numbered off the STORED roster, not
    // just off the shipped species. Missing that half is what this caught.
    const problems = draftProblems(game, validDraft(), existing);
    expect(problems).toEqual([]);
    expect(slugifyId("Clarkosaur", takenIds(game, existing))).toBe("clarkosaur-2");
  });
});

describe("rows", () => {
  it("lists a move row per candidate and a save row that reports the shortfall", () => {
    const bodies = ["battler_02", "battler_04"];
    const rows = buildRows(game, { ...freshDraft("grass"), def: 55 }, bodies, false);
    const kinds = rows.map((r) => r.row.kind);
    expect(kinds).toContain("body");
    expect(kinds).toContain("name");
    expect(kinds).toContain("import");
    expect(kinds.filter((k) => k === "move").length).toBe(moveCandidates(game, "grass").length);
    expect(rows.find((r) => r.row.kind === "save")!.value).toContain("5 points left");
  });

  it("marks chosen moves with a filled box", () => {
    const id = moveCandidates(game, "grass")[0].id;
    const rows = buildRows(game, { ...freshDraft("grass"), moves: [id] }, ["battler_02"], false);
    const picked = rows.find((r) => r.row.kind === "move" && r.row.id === id)!;
    expect(picked.label).toContain("☑");
  });
});

describe("bodies on offer", () => {
  it("excludes battlers the shipped game already uses", () => {
    const loaded = {
      manifest: {
        sheets: {},
        sprites: {
          battler_01: { sheet: "battlers_a", anims: {} },
          battler_02: { sheet: "battlers_a", anims: {} },
          player: { sheet: "player", anims: {} },
        },
      },
      sheets: new Map(),
    } as never;
    const spritesDoc = { species: { emberling: "battler_01" } };
    expect(freeBodies(loaded, spritesDoc)).toEqual(["battler_02"]);
  });

  it("survives a game with no sprites document at all", () => {
    const loaded = {
      manifest: { sheets: {}, sprites: { battler_09: { sheet: "battlers_a", anims: {} } } },
      sheets: new Map(),
    } as never;
    expect(freeBodies(loaded, undefined)).toEqual(["battler_09"]);
  });
});
