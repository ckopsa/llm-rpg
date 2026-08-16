import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Sim, observe, validateGame, type Game } from "../src/index.js";

/**
 * djt.4 — acts, endings, and observed scenes: the `end` command and
 * state.ending, `win` as sugar for end{id:"victory"} (events pinned),
 * post-ending action refusal, teleport_player validation, show_title,
 * validation's endings collection, the ungated-end-last rule, byte-parity
 * for shipped games, and the heavenly-court observed-scene pattern.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

/** One-room narrative game whose keeper offers two endings via a choice. */
function endingsFixture(): unknown {
  return {
    meta: { id: "ending-test", title: "Ending Test", goal: "choose how it ends" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          {
            id: "keeper", name: "Keeper", glyph: "K", x: 2, y: 1,
            interactions: [
              {
                commands: [
                  {
                    type: "choice",
                    prompt: "Stay or go?",
                    options: [
                      {
                        label: "Stay",
                        commands: [{ type: "end", id: "victory", text: "You stay, and it is enough." }],
                      },
                      {
                        label: "Go",
                        commands: [{ type: "end", id: "exile", text: "You walk into the dark." }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    player: { glyph: "@", map: "main", x: 1, y: 1 },
  };
}

describe("end command", () => {
  it("a non-victory ending stops the game without winning", () => {
    const sim = new Sim(load(endingsFixture()), 1);
    sim.act({ type: "interact" });
    const events = sim.act({ type: "choose", index: 1 });
    expect(events).toContain("You walk into the dark.");
    expect(events).toContain("*** THE END — exile ***");
    expect(sim.state.ending).toEqual({ id: "exile", text: "You walk into the dark." });
    expect(sim.state.won).toBe(false);
    // Further actions are refused the way `won` refuses them.
    const refused = sim.act({ type: "move", dir: "east" });
    expect(refused).toEqual(["The game has ended. Reset to play again."]);
    expect(sim.state.turn).toBe(2);
    expect(observe(sim)).toContain("Status: ENDED — exile");
  });

  it('end { id: "victory" } IS winning', () => {
    const sim = new Sim(load(endingsFixture()), 1);
    sim.act({ type: "interact" });
    const events = sim.act({ type: "choose", index: 0 });
    expect(events).toContain("You stay, and it is enough.");
    expect(events).toContain("*** YOU WIN ***");
    expect(sim.state.won).toBe(true);
    expect(sim.state.ending).toEqual({ id: "victory", text: "You stay, and it is enough." });
    expect(sim.act({ type: "interact" })).toEqual([
      "The game is already won. Reset to play again.",
    ]);
  });

  it("multiple endings are legal and validation collects their ids", () => {
    const r = validateGame(endingsFixture());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.endings).toEqual(["exile", "victory"]);
  });

  it("an ending ends commands mid-frame like win does", () => {
    const raw = endingsFixture() as {
      maps: { main: { entities: { interactions: { commands: unknown[] }[] }[] } };
    };
    raw.maps.main.entities[0].interactions = [
      {
        commands: [
          { type: "end", id: "quiet", text: "It ends quietly.", when: { flag: "ready" } },
          { type: "say", text: "Not yet." },
          { type: "set_flag", flag: "ready" },
        ],
      },
    ];
    const sim = new Sim(load(raw), 1);
    const first = sim.act({ type: "interact" }); // gate fails: chat instead
    expect(first).toContain('Keeper: "Not yet."');
    expect(sim.state.ending).toBeNull();
    const second = sim.act({ type: "interact" });
    expect(second).toContain("It ends quietly.");
    expect(second).not.toContain('Keeper: "Not yet."'); // frames stop at the end
    expect(sim.state.ending!.id).toBe("quiet");
  });

  it("ungated end must be last; a when-gated end may sit mid-list", () => {
    const bad = endingsFixture() as {
      maps: { main: { entities: { interactions: unknown[] }[] } };
    };
    bad.maps.main.entities[0].interactions = [
      {
        commands: [
          { type: "end", id: "early", text: "Too soon." },
          { type: "say", text: "unreachable" },
        ],
      },
    ];
    const r = validateGame(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('an ungated "end" must be the last command'))).toBe(true);
  });

  it("win sugar: sets ending victory, events and won-refusal unchanged", () => {
    const raw = endingsFixture() as {
      maps: { main: { entities: { interactions: unknown[] }[] } };
    };
    raw.maps.main.entities[0].interactions = [
      { commands: [{ type: "win", text: "The road is complete." }] },
    ];
    const sim = new Sim(load(raw), 1);
    const events = sim.act({ type: "interact" });
    expect(events).toEqual(["The road is complete.", "*** YOU WIN ***"]);
    expect(sim.state.won).toBe(true);
    expect(sim.state.ending).toEqual({ id: "victory", text: "The road is complete." });
    expect(sim.act({ type: "interact" })).toEqual([
      "The game is already won. Reset to play again.",
    ]);
  });

  it("ending round-trips through snapshots", () => {
    const game = load(endingsFixture());
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    sim.act({ type: "choose", index: 1 });
    const restored = Sim.fromSnapshot(game, JSON.parse(JSON.stringify(sim.snapshot())));
    expect(restored.state.ending).toEqual({ id: "exile", text: "You walk into the dark." });
    expect(restored.act({ type: "interact" })).toEqual([
      "The game has ended. Reset to play again.",
    ]);
  });
});

describe("teleport_player validation", () => {
  const withTeleport = (cmd: object): unknown => {
    const raw = endingsFixture() as {
      maps: { main: { entities: { interactions: unknown[] }[] } };
    };
    raw.maps.main.entities[0].interactions = [{ commands: [cmd] }];
    return raw;
  };

  it("checks the destination map, bounds, and walkability", () => {
    const badMap = validateGame(
      withTeleport({ type: "teleport_player", mapId: "moon", x: 1, y: 1 }),
    );
    expect(badMap.ok).toBe(false);
    expect(badMap.errors.some((e) => e.includes('"moon" is not a defined map'))).toBe(true);

    const badTile = validateGame(
      withTeleport({ type: "teleport_player", mapId: "main", x: 0, y: 0 }),
    );
    expect(badTile.ok).toBe(false);
    expect(badTile.errors.some((e) => e.includes("non-walkable"))).toBe(true);

    const good = validateGame(
      withTeleport({ type: "teleport_player", mapId: "main", x: 3, y: 1 }),
    );
    expect(good.errors).toEqual([]);
  });
});

describe("the heavenly-court pattern (observed scenes)", () => {
  /**
   * The player prays at an altar on EARTH; the scene cuts to a court map the
   * player never visits, where entities speak and move, then returns:
   *   show_title → camera_focus (court) → passage/say → move_entity → release.
   */
  const courtFixture = (): unknown => ({
    meta: { id: "court-test", title: "Court Test", goal: "witness the wager" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      earth: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          {
            id: "altar", name: "Altar", glyph: "A", x: 2, y: 1,
            interactions: [
              {
                commands: [
                  { type: "show_title", text: "Meanwhile", subtitle: "In the court above" },
                  { type: "camera_focus", entityId: "accuser" },
                  {
                    type: "passage",
                    lines: ["Whence comest thou?", "From going to and fro in the earth."],
                    citation: "Job 1:7",
                  },
                  { type: "move_entity", entityId: "accuser", path: ["east", "east"] },
                  { type: "set_flag", flag: "wager_struck" },
                  { type: "camera_focus", release: true },
                ],
              },
            ],
          },
        ],
      },
      court: {
        rows: ["#######", "#.....#", "#######"],
        entities: [
          { id: "accuser", name: "The Accuser", glyph: "s", x: 1, y: 1, interactions: [] },
        ],
      },
    },
    player: { glyph: "@", map: "earth", x: 1, y: 1 },
  });

  it("plays a scene on a map the player is not on, then returns", () => {
    const game = load(courtFixture());
    const sim = new Sim(game, 1);
    const events = sim.act({ type: "interact" });

    // The player never moved.
    expect(sim.state.map).toBe("earth");
    expect([sim.state.playerX, sim.state.playerY]).toEqual([1, 1]);

    // Events narrate the scene in order.
    const titleIdx = events.indexOf("— Meanwhile —\nIn the court above");
    const focusIdx = events.indexOf("The scene turns to The Accuser.");
    const passageIdx = events.findIndex((e) => e.includes("Whence comest thou?"));
    const moveIdx = events.indexOf("The Accuser moves east, east.");
    const releaseIdx = events.indexOf("The scene returns to you.");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeGreaterThan(titleIdx);
    expect(passageIdx).toBeGreaterThan(focusIdx);
    expect(moveIdx).toBeGreaterThan(passageIdx);
    expect(releaseIdx).toBeGreaterThan(moveIdx);

    // Cues carry the renderer's pacing record, cross-map focus included.
    expect(sim.state.lastCues).toEqual([
      { kind: "show_title", text: "Meanwhile", subtitle: "In the court above" },
      { kind: "camera_focus", entityId: "accuser", mapId: "court", x: 1, y: 1 },
      { kind: "move_entity", entityId: "accuser", mapId: "court",
        from: { x: 1, y: 1 }, to: { x: 3, y: 1 }, steps: ["east", "east"] },
      { kind: "camera_focus", release: true },
    ]);

    // The passage rendered in full, the flag stuck, the overlay persists.
    expect(sim.state.lastPassages).toEqual([
      { lines: ["Whence comest thou?", "From going to and fro in the earth."], citation: "Job 1:7" },
    ]);
    expect(sim.state.flags).toContain("wager_struck");
    expect(sim.entitiesOn("court").map((e) => [e.id, e.x, e.y])).toEqual([["accuser", 3, 1]]);
  });
});

describe("back-compat pins for shipped games", () => {
  for (const rel of ["games/demo/game.json", "games/emberwood/game.json"]) {
    it(`${rel} validates identically — no new keys materialize in the parsed doc`, () => {
      const r = validateGame(JSON.parse(readFileSync(`${ROOT}${rel}`, "utf8")));
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.ok).toBe(true);
      // Strictly additive schema: absent optional fields stay absent.
      const text = JSON.stringify(r.game);
      expect(text).not.toContain('"triggers"');
      expect(text).not.toContain('"variants"');
      expect(text).not.toContain('"sprite"');
      // `win` is the only ending both games define.
      expect(r.endings).toEqual(["victory"]);
    });
  }

  it("a fresh sim on the demo game starts with empty overlay/ending state", () => {
    const game = load(JSON.parse(readFileSync(`${ROOT}games/demo/game.json`, "utf8")));
    const sim = new Sim(game, 1);
    expect(sim.state.entityOverrides).toEqual({});
    expect(sim.state.spawnedEntities).toEqual([]);
    expect(sim.state.tileOverrides).toEqual({});
    expect(sim.state.firedTriggers).toEqual([]);
    expect(sim.state.lastCues).toEqual([]);
    expect(sim.state.ending).toBeNull();
    expect(sim.state.variantOverrides).toEqual({});
    expect(sim.state.lastEvents).toEqual([]); // no triggers fired at start
  });
});
