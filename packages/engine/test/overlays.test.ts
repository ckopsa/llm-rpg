import { describe, expect, it } from "vitest";
import {
  GameSchema,
  Sim,
  observe,
  renderGrid,
  validateGame,
  type Cue,
  type Game,
} from "../src/index.js";

/**
 * djt.3 (world overlays) — entity positions/tiles become mutable sim state:
 * entityOverrides, spawnedEntities, tileOverrides. Every sim read (entityAt,
 * tileAt, walkability, trainer line of sight, interact, observers) consults
 * the overlays; snapshots round-trip them; determinism holds. Plus the
 * cutscene command set (move_entity, spawn_entity, remove_entity, set_tile,
 * wait, camera_focus, play_music, screen_effect) and the lastCues channel.
 */

/**
 * Narrative fixture (no catalog). 7x4 main map:
 *   #######
 *   #@...E#     E = elder (5,1)
 *   #D....#     D = director (1,2) — its interaction runs the cutscene
 *   #######
 * plus a detached "yard" map with a groundskeeper.
 */
function fixture(directorCommands: unknown[]): unknown {
  return {
    meta: { id: "overlay-test", title: "Overlay Test", goal: "test overlays" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#######", "#.....#", "#.....#", "#######"],
        entities: [
          {
            id: "elder", name: "Elder", glyph: "E", x: 5, y: 1,
            interactions: [{ commands: [{ type: "say", text: "Hm?" }] }],
          },
          {
            id: "director", name: "Director", glyph: "D", x: 1, y: 2,
            interactions: [{ commands: directorCommands }],
          },
        ],
      },
      yard: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          {
            id: "keeper", name: "Groundskeeper", glyph: "K", x: 1, y: 1,
            interactions: [{ commands: [{ type: "say", text: "Shoo." }] }],
          },
        ],
      },
    },
    player: { glyph: "@", map: "main", x: 1, y: 1 },
  };
}

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

/** Interact with the director (adjacent south of the start position). */
function run(directorCommands: unknown[], seed = 1): Sim {
  const sim = new Sim(load(fixture(directorCommands)), seed);
  sim.act({ type: "interact" });
  return sim;
}

describe("move_entity and overlay reads", () => {
  it("walks the entity tile-by-tile; entityAt/grid/nearby see the new position", () => {
    const sim = run([{ type: "move_entity", entityId: "elder", path: ["west", "west"] }]);
    expect(sim.state.lastEvents).toContain("Elder moves west, west.");
    expect(sim.entityAt(5, 1)).toBeUndefined();
    expect(sim.entityAt(3, 1)!.id).toBe("elder");
    const grid = renderGrid(sim);
    expect(grid.split("\n")[1]).toBe("#@.E..#");
    expect(observe(sim)).toContain("E Elder — 2 east");
  });

  it("a blocked step stops the remaining movement with an event and a cue", () => {
    // west to (4,1), then north into the wall: stops, east never happens.
    const sim = run([
      { type: "move_entity", entityId: "elder", path: ["west", "north", "east"] },
    ]);
    expect(sim.state.lastEvents).toContain("Elder moves west.");
    expect(sim.state.lastEvents).toContain("Elder stops — the way north is blocked.");
    expect(sim.entityAt(4, 1)!.id).toBe("elder");
    const cue = sim.state.lastCues.find((c) => c.kind === "move_entity") as Extract<
      Cue,
      { kind: "move_entity" }
    >;
    expect(cue.from).toEqual({ x: 5, y: 1 });
    expect(cue.to).toEqual({ x: 4, y: 1 });
    expect(cue.steps).toEqual(["west"]);
    expect(cue.blocked).toBe("north");
  });

  it("the player and other entities block a step", () => {
    // Elder walks west along row 1 toward the player at (1,1): stops at (2,1).
    const sim = run([
      { type: "move_entity", entityId: "elder", path: ["west", "west", "west", "west"] },
    ]);
    expect(sim.entityAt(2, 1)!.id).toBe("elder");
    expect(sim.state.lastEvents).toContain("Elder stops — the way west is blocked.");

    // Director at (1,2) walks north into the player's tile: blocked at once.
    const sim2 = run([{ type: "move_entity", entityId: "director", path: ["north"] }]);
    expect(sim2.state.lastEvents).toContain("Director stops — the way north is blocked.");
    const cue = sim2.state.lastCues[0] as Extract<Cue, { kind: "move_entity" }>;
    expect(cue.steps).toEqual([]);

    // Elder walks into the director's tile: blocked.
    const sim3 = run([
      { type: "move_entity", entityId: "elder", path: ["south", "west", "west", "west", "west"] },
    ]);
    expect(sim3.entityAt(2, 2)!.id).toBe("elder");
  });

  it("moves entities on OTHER maps (overlays are map-scoped)", () => {
    const sim = run([{ type: "move_entity", entityId: "keeper", path: ["east", "east"] }]);
    expect(sim.state.lastEvents).toContain("Groundskeeper moves east, east.");
    const yard = sim.entitiesOn("yard");
    expect(yard.map((e) => [e.id, e.x, e.y])).toEqual([["keeper", 3, 1]]);
    // Player never moved.
    expect(sim.state.map).toBe("main");
  });

  it("a moved blocking entity blocks player movement at its NEW position", () => {
    const sim = run([{ type: "move_entity", entityId: "elder", path: ["west", "west", "west"] }]);
    // Elder now at (2,1); player at (1,1) moving east bumps into it.
    const events = sim.act({ type: "move", dir: "east" });
    expect(events).toContain('Elder is standing there. Try "interact".');
    // And its old tile is walkable again.
    expect(sim.entityAt(5, 1)).toBeUndefined();
  });

  it("interact targets the entity at its effective position", () => {
    const sim = run([{ type: "move_entity", entityId: "elder", path: ["west", "west", "west"] }]);
    // Elder at (2,1) is adjacent to the player at (1,1).
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Elder: "Hm?"');
  });
});

describe("spawn_entity / remove_entity", () => {
  const dog = {
    id: "dog", name: "Dog", glyph: "d", x: 3, y: 2,
    interactions: [{ commands: [{ type: "say", text: "Woof." }] }],
  };

  it("spawns on the current map by default; reads and interactions work", () => {
    const sim = run([{ type: "spawn_entity", entity: dog }]);
    expect(sim.state.lastEvents).toContain("Dog appears.");
    expect(sim.entityAt(3, 2)!.name).toBe("Dog");
    expect(renderGrid(sim).split("\n")[2]).toBe("#D.d..#");
    // Walk to (3,1), directly north of the dog, and talk.
    sim.act({ type: "move", dir: "east" });
    sim.act({ type: "move", dir: "east" });
    const events = sim.act({ type: "interact" });
    expect(events).toContain('Dog: "Woof."');
  });

  it("spawns onto another map with mapId", () => {
    const sim = run([
      { type: "spawn_entity", mapId: "yard", entity: { ...dog, x: 3, y: 1 } },
    ]);
    expect(sim.entitiesOn("yard").map((e) => e.id)).toEqual(["keeper", "dog"]);
    expect(sim.entityAt(3, 1)).toBeUndefined(); // not on the player's map
  });

  it("rejects duplicate ids, occupied tiles, and out-of-bounds spawns with events", () => {
    const dup = run([{ type: "spawn_entity", entity: { ...dog, id: "spawned" } },
      { type: "spawn_entity", entity: { ...dog, id: "spawned", x: 4, y: 2 } }]);
    expect(dup.state.lastEvents).toContain(
      'Nothing happens — an entity with id "spawned" already exists.',
    );
    const occupied = run([{ type: "spawn_entity", entity: { ...dog, x: 5, y: 1 } }]);
    expect(occupied.state.lastEvents).toContain(
      'Nothing happens — (5, 1) on "main" is already occupied.',
    );
    expect(occupied.state.spawnedEntities).toEqual([]);
    const oob = run([{ type: "spawn_entity", entity: { ...dog, x: 9, y: 9 } }]);
    expect(oob.state.lastEvents).toContain('Nothing happens — (9, 9) is outside map "main".');
  });

  it("removes placed and spawned entities; grid, nearby, and interact forget them", () => {
    const sim = run([{ type: "remove_entity", entityId: "elder" }]);
    expect(sim.state.lastEvents).toContain("Elder departs.");
    expect(sim.entityAt(5, 1)).toBeUndefined();
    expect(observe(sim)).not.toContain("E Elder"); // gone from grid and nearby
    expect(sim.state.entityOverrides.elder).toEqual({ removed: true });

    const sim2 = run([
      { type: "spawn_entity", entity: dog },
      { type: "remove_entity", entityId: "dog" },
    ]);
    expect(sim2.state.spawnedEntities).toEqual([]);
    expect(sim2.entityAt(3, 2)).toBeUndefined();

    // Unknown ids are a VALIDATION error; at runtime (unvalidated game, or an
    // entity already removed) they degrade to an event.
    const unvalidated = GameSchema.parse(fixture([{ type: "remove_entity", entityId: "nobody" }]));
    const sim3 = new Sim(unvalidated, 1);
    sim3.act({ type: "interact" });
    expect(sim3.state.lastEvents).toContain(
      'Nothing happens — no entity "nobody" is present.',
    );
  });
});

describe("set_tile", () => {
  it("repaints a tile: walkability and rendering follow the new legend char", () => {
    // Wall off the corridor at (2,1), then try to walk into it.
    const sim = run([{ type: "set_tile", x: 2, y: 1, char: "#" }]);
    expect(sim.state.lastEvents).toContain("The floor becomes wall.");
    expect(sim.tileAt(2, 1).walkable).toBe(false);
    const events = sim.act({ type: "move", dir: "east" });
    expect(events).toContain("You can't go east — wall blocks the way.");
    expect(renderGrid(sim).split("\n")[1]).toBe("#@#..E#");
  });

  it("opens a wall on another map via mapId, and repaint-overrides stack", () => {
    const sim = run([
      { type: "set_tile", mapId: "yard", x: 1, y: 0, char: "." },
      { type: "set_tile", mapId: "yard", x: 1, y: 0, char: "#" }, // repaint same tile
    ]);
    expect(sim.state.tileOverrides.yard).toEqual([{ x: 1, y: 0, char: "#" }]);
  });

  it("rejects out-of-bounds coordinates with an event", () => {
    const sim = run([{ type: "set_tile", x: 9, y: 9, char: "#" }]);
    expect(sim.state.lastEvents).toContain(
      'Nothing happens — (9, 9) is outside map "main".',
    );
  });
});

describe("trainer line of sight consults overlays", () => {
  /** Catalog game: watcher trainer at (5,2) looking west 3 tiles on row 2. */
  const trainerRaw = (directorCommands: unknown[]): unknown => ({
    meta: { id: "los-test", title: "LoS Test", goal: "test sight" },
    catalog: {
      typeChart: { types: ["normal"], effectiveness: {} },
      moves: [{ id: "tap", name: "Tap", type: "normal", power: 10, accuracy: 1, pp: 10 }],
      species: [
        { id: "critter", name: "Critter", glyph: "c", types: ["normal"],
          baseStats: { hp: 30, atk: 20, def: 20, spd: 10 },
          learnset: [{ level: 1, moveId: "tap" }], catchRate: 0.5, xpYield: 10 },
      ],
      items: [],
    },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#######", "#.....#", "#.....#", "#######"],
        entities: [
          {
            id: "watcher", name: "Watcher", glyph: "W", x: 5, y: 2,
            trainer: {
              party: [{ speciesId: "critter", level: 3 }],
              defeatFlag: "watcher_beaten",
              lineOfSight: { dir: "west", range: 4 },
            },
          },
          {
            id: "director", name: "Director", glyph: "D", x: 2, y: 1,
            interactions: [{ commands: directorCommands }],
          },
        ],
      },
    },
    player: {
      glyph: "@", map: "main", x: 1, y: 1,
      party: [{ speciesId: "critter", level: 5 }],
    },
  });

  const blocker = { id: "statue", name: "Statue", glyph: "S", x: 3, y: 2, interactions: [] };

  it("a spawned entity blocks the sight line; removing it re-opens it", () => {
    const game = load(trainerRaw([{ type: "spawn_entity", entity: blocker }]));
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" }); // director spawns the statue at (3,2)
    sim.act({ type: "move", dir: "south" }); // player to (1,2): behind the statue
    expect(sim.state.battle).toBeNull();
    // Without the statue the same tile is seen.
    const bare = new Sim(load(trainerRaw([{ type: "say", text: "hi" }])), 1);
    bare.act({ type: "interact" });
    bare.act({ type: "move", dir: "south" });
    expect(bare.state.battle).not.toBeNull();
    expect(bare.state.battleTrainer).toBe("watcher");
  });

  it("a MOVED trainer watches from its new position", () => {
    // Move the watcher one north: it now watches row 1 instead of row 2.
    const game = load(
      trainerRaw([{ type: "move_entity", entityId: "watcher", path: ["north"] }]),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" }); // watcher moves to (5,1)
    sim.act({ type: "move", dir: "east" }); // player to... blocked by director? director at (2,1)
    expect(sim.state.lastEvents).toContain('Director is standing there. Try "interact".');
    sim.act({ type: "move", dir: "south" }); // (1,2) — old sight row, no longer watched
    expect(sim.state.battle).toBeNull();
    sim.act({ type: "move", dir: "east" }); // (2,2)
    sim.act({ type: "move", dir: "east" }); // (3,2)
    expect(sim.state.battle).toBeNull();
    sim.act({ type: "move", dir: "north" }); // (3,1) — 2 west of the moved watcher: seen
    expect(sim.state.battle).not.toBeNull();
  });

  it("a removed trainer no longer engages", () => {
    const game = load(
      trainerRaw([{ type: "remove_entity", entityId: "watcher" }]),
    );
    const sim = new Sim(game, 1);
    sim.act({ type: "interact" });
    sim.act({ type: "move", dir: "south" });
    expect(sim.state.battle).toBeNull();
    expect(observe(sim)).not.toContain("Watcher");
  });
});

describe("cue channel", () => {
  const sequence = [
    { type: "play_music", track: "storm-theme" },
    { type: "show_title", text: "Act I", subtitle: "The Storm" },
    { type: "camera_focus", entityId: "elder" },
    { type: "say", text: "It begins." },
    { type: "wait", beats: 2 },
    { type: "screen_effect", effect: "shake" },
    { type: "move_entity", entityId: "elder", path: ["west"] },
    { type: "camera_focus", release: true },
  ];

  it("renderer-directed commands append ordered structured cues", () => {
    const sim = run(sequence);
    expect(sim.state.lastCues).toEqual([
      { kind: "play_music", track: "storm-theme" },
      { kind: "show_title", text: "Act I", subtitle: "The Storm" },
      { kind: "camera_focus", entityId: "elder", mapId: "main", x: 5, y: 1 },
      { kind: "wait", beats: 2 },
      { kind: "screen_effect", effect: "shake" },
      { kind: "move_entity", entityId: "elder", mapId: "main",
        from: { x: 5, y: 1 }, to: { x: 4, y: 1 }, steps: ["west"] },
      { kind: "camera_focus", release: true },
    ]);
    // Text observers narrate the same sequence as ordered events.
    const ev = sim.state.lastEvents;
    expect(ev).toContain("♪ storm-theme");
    expect(ev).toContain("— Act I —\nThe Storm");
    expect(ev).toContain("The scene turns to Elder.");
    expect(ev).toContain('Director: "It begins."');
    expect(ev).toContain("…");
    expect(ev).toContain("The world shakes.");
    expect(ev).toContain("The scene returns to you.");
    expect(ev.indexOf("♪ storm-theme")).toBeLessThan(ev.indexOf("The world shakes."));
  });

  it("camera_focus can aim at a tile on another map", () => {
    const sim = run([{ type: "camera_focus", mapId: "yard", x: 2, y: 1 }]);
    expect(sim.state.lastCues).toEqual([{ kind: "camera_focus", mapId: "yard", x: 2, y: 1 }]);
    expect(sim.state.lastEvents).toContain("The scene turns to yard (2, 1).");
  });

  it("lastCues clears on the next act, like lastEvents", () => {
    const sim = run(sequence);
    expect(sim.state.lastCues.length).toBeGreaterThan(0);
    sim.act({ type: "move", dir: "east" });
    expect(sim.state.lastCues).toEqual([]);
  });
});

describe("snapshots and determinism through a cutscene", () => {
  const sequence = [
    { type: "spawn_entity", entity: { id: "dog", name: "Dog", glyph: "d", x: 3, y: 2, interactions: [] } },
    { type: "move_entity", entityId: "elder", path: ["west", "west"] },
    { type: "set_tile", x: 2, y: 1, char: "#" },
    { type: "remove_entity", entityId: "keeper" },
    { type: "play_music", track: "quiet" },
  ];

  it("every overlay field round-trips through JSON and the reads agree", () => {
    const game = load(fixture(sequence));
    const sim = new Sim(game, 5);
    sim.act({ type: "interact" });
    const snap = JSON.parse(JSON.stringify(sim.snapshot()));
    const restored = Sim.fromSnapshot(game, snap);
    expect(restored.state).toEqual(sim.state);
    expect(restored.entityAt(3, 1)!.id).toBe("elder");
    expect(restored.entityAt(3, 2)!.id).toBe("dog");
    expect(restored.tileAt(2, 1).walkable).toBe(false);
    expect(restored.entitiesOn("yard")).toEqual([]);
    expect(renderGrid(restored)).toBe(renderGrid(sim));
  });

  it("old snapshots without the overlay fields load with defaults", () => {
    const game = load(fixture(sequence));
    const sim = new Sim(game, 5);
    const snap = sim.snapshot() as unknown as Record<string, unknown>;
    delete snap.entityOverrides;
    delete snap.spawnedEntities;
    delete snap.tileOverrides;
    delete snap.firedTriggers;
    delete snap.lastCues;
    delete snap.ending;
    delete snap.variantOverrides;
    const restored = Sim.fromSnapshot(game, snap as never);
    expect(restored.state.entityOverrides).toEqual({});
    expect(restored.state.spawnedEntities).toEqual([]);
    expect(restored.state.tileOverrides).toEqual({});
    expect(restored.state.firedTriggers).toEqual([]);
    expect(restored.state.lastCues).toEqual([]);
    expect(restored.state.ending).toBeNull();
    expect(restored.state.variantOverrides).toEqual({});
    // And it still plays.
    restored.act({ type: "move", dir: "east" });
    expect(restored.state.playerX).toBe(2);
  });

  it("replays deterministically through a full cutscene", () => {
    const game = load(fixture(sequence));
    const play = () => {
      const sim = new Sim(game, 42);
      sim.act({ type: "interact" });
      sim.act({ type: "move", dir: "south" });
      sim.act({ type: "interact" });
      return sim.snapshot();
    };
    expect(play()).toEqual(play());
  });
});

describe("validation of overlay commands", () => {
  it("checks move/remove/camera entity refs, set_tile chars/bounds, spawn payloads", () => {
    const r = validateGame(
      fixture([
        { type: "move_entity", entityId: "ghost", path: ["north"] },
        { type: "remove_entity", entityId: "phantom" },
        { type: "camera_focus", entityId: "wisp" },
        { type: "set_tile", x: 1, y: 1, char: "?" },
        { type: "set_tile", mapId: "yard", x: 99, y: 0, char: "#" },
        { type: "spawn_entity", mapId: "nowhere", entity: { id: "a", name: "A", glyph: "a", x: 0, y: 0 } },
        { type: "spawn_entity", entity: { id: "elder", name: "Twin", glyph: "T", x: 3, y: 2 } },
      ]),
    );
    expect(r.ok).toBe(false);
    const text = r.errors.join("\n");
    expect(text).toContain('entityId "ghost" is not a defined entity');
    expect(text).toContain('entityId "phantom" is not a defined entity');
    expect(text).toContain('entityId "wisp" is not a defined entity');
    expect(text).toContain('"?" is not in the legend');
    expect(text).toContain('(99, 0) is outside');
    expect(text).toContain('"nowhere" is not a defined map');
    expect(text).toContain('entity id "elder" already exists on map "main"');
  });

  it("accepts references to entities created by spawn_entity elsewhere", () => {
    const r = validateGame(
      fixture([
        { type: "move_entity", entityId: "dog", path: ["east"] },
        { type: "spawn_entity", entity: { id: "dog", name: "Dog", glyph: "d", x: 3, y: 2 } },
      ]),
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("recurses into spawn_entity payload dialogue with full paths", () => {
    const r = validateGame(
      fixture([
        {
          type: "spawn_entity",
          entity: {
            id: "peddler", name: "Peddler", glyph: "p", x: 3, y: 2,
            interactions: [{ commands: [{ type: "give_item", itemId: "nope", qty: 1 }] }],
          },
        },
      ]),
    );
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) =>
        e.includes(".entity.interactions[0].commands[0]") && e.includes("give_item"),
      ),
    ).toBe(true);
  });

  it("enforces the camera_focus exactly-one-target and wait/path shapes", () => {
    const both = validateGame(
      fixture([{ type: "camera_focus", entityId: "elder", x: 1, y: 1 }]),
    );
    expect(both.ok).toBe(false);
    expect(both.errors.some((e) => e.includes("exactly one target"))).toBe(true);

    const badWait = validateGame(fixture([{ type: "wait", beats: 0 }]));
    expect(badWait.ok).toBe(false);
    expect(badWait.errors.some((e) => e.includes("beats must be at least 1"))).toBe(true);

    const emptyPath = validateGame(
      fixture([{ type: "move_entity", entityId: "elder", path: [] }]),
    );
    expect(emptyPath.ok).toBe(false);
    expect(emptyPath.errors.some((e) => e.includes("path needs at least one step"))).toBe(true);
  });
});
