import type {
  Command,
  Entity,
  Game,
  Interaction,
  InventoryEntry,
  MapDef,
  Portal,
  WhenContext,
} from "./schema.js";
import { evalWhen } from "./schema.js";
import type { Item } from "./catalog.js";
import { itemById, speciesById, statsAtLevel, moveById } from "./catalog.js";
import type { BattleState, Combatant, PlayerAction } from "./battle.js";
import { Battle, createBattle, createCombatant } from "./battle.js";
import { Rng, type RngState } from "./rng.js";

export type Direction = "north" | "south" | "east" | "west";

/**
 * Overworld actions plus battle actions. While a battle is active the sim
 * accepts ONLY battle_* actions and routes them to the Battle; overworld
 * actions are rejected with a pointer to the valid ones (and vice versa).
 * All indexes here are 0-based; the string forms ("move1", "switch2",
 * "item3") are 1-based and parsed by `parseAction`.
 */
export type Action =
  | { type: "move"; dir: Direction }
  | { type: "interact" }
  | { type: "choose"; index: number }
  | { type: "battle_move"; index: number }
  | { type: "battle_switch"; index: number }
  | { type: "battle_item"; index: number }
  | { type: "battle_catch" }
  | { type: "battle_run" };

/** One long-form passage produced by a `passage` command (see schema.ts).
 *  Rendered in full by observers — never truncated. */
export interface Passage {
  title?: string;
  lines: string[];
  citation?: string;
}

/** One presented option of a pending choice. Commands are carried in the
 *  state (plain JSON) so a mid-choice snapshot restores exactly. */
export interface PendingChoiceOption {
  label: string;
  commands: Command[];
}

/** World-overlay record for one PLACED entity: position/map overrides from
 *  move_entity (and future cross-map moves), `removed` from remove_entity.
 *  Spawned entities live in `spawnedEntities` and are mutated directly. */
export interface EntityOverride {
  x?: number;
  y?: number;
  mapId?: string;
  removed?: true;
}

/** A runtime-spawned entity and the map it lives on. */
export interface SpawnedEntityRecord {
  mapId: string;
  entity: Entity;
}

/** One repainted tile (from set_tile); `char` indexes the legend. */
export interface TileOverride {
  x: number;
  y: number;
  char: string;
}

/** How the game ended. `won` is true iff `id === "victory"` (the `win`
 *  command is sugar for `end { id: "victory" }`). */
export interface Ending {
  id: string;
  text: string;
}

/**
 * One renderer-directed cutscene record. Cues land in `state.lastCues`
 * (cleared each act, like lastEvents) so a renderer can pace the sequence;
 * sim state itself is already in the final post-sequence configuration.
 * Every cue-emitting command also pushes a text event, so text observers
 * narrate sequences with zero extra work.
 */
export type Cue =
  | {
      kind: "move_entity";
      entityId: string;
      mapId: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
      /** The steps actually walked (may be shorter than the commanded path). */
      steps: Direction[];
      /** Direction of the step that was blocked, if any. */
      blocked?: Direction;
    }
  | { kind: "spawn_entity"; entityId: string; mapId: string; x: number; y: number; glyph: string }
  | { kind: "remove_entity"; entityId: string; mapId: string; x: number; y: number }
  | { kind: "set_tile"; mapId: string; x: number; y: number; char: string }
  | { kind: "wait"; beats: number }
  | {
      kind: "camera_focus";
      entityId?: string;
      mapId?: string;
      x?: number;
      y?: number;
      release?: true;
    }
  | { kind: "play_music"; track: string }
  | { kind: "screen_effect"; effect: "shake" | "flash" | "fade" }
  | { kind: "show_title"; text: string; subtitle?: string };

/**
 * A `choice` command awaiting resolution. While non-null, the sim accepts
 * ONLY `{ type: "choose", index }`. Only the options whose `when` passed at
 * presentation time are here (order preserved). `continuations` holds the
 * command lists the choice suspended (outermost first, innermost last): the
 * chosen option's commands run first, then continuations resume innermost
 * first. Everything is plain JSON — snapshot/restore works mid-choice.
 */
export interface PendingChoice {
  /** Source id whose command list produced the choice: an entity id, or a
   *  "trigger:mapId:id" token for trigger-sourced choices (narrator voice). */
  sourceId: string;
  prompt: string;
  options: PendingChoiceOption[];
  continuations: Command[][];
  /** Source ids aligned with `continuations` — a suspended frame keeps its
   *  own speaker (e.g. a trigger queued behind an NPC's dialogue). Absent in
   *  older snapshots: every continuation falls back to `sourceId`. */
  continuationSources?: string[];
}

export interface SimState {
  /** Id of the map the player is currently on. */
  map: string;
  playerX: number;
  playerY: number;
  flags: string[];
  /** Named game variables (numbers or strings) written by set_var/add_var
   *  and read by `when` conditions. */
  vars: Record<string, number | string>;
  won: boolean;
  turn: number;
  /** The player's creatures (max 6). Battle damage persists on the overworld. */
  party: Combatant[];
  inventory: InventoryEntry[];
  money: number;
  /** Active battle state, or null. While non-null, only battle actions work. */
  battle: BattleState | null;
  /** Entity id of the trainer being battled, or null (wild battle / no battle).
   *  Victory rewards settle against this entity when the battle ends. */
  battleTrainer: string | null;
  /** A dialogue choice awaiting resolution, or null. While non-null only
   *  `choose` actions are accepted (overworld-only: battles can't start,
   *  movement is blocked). Cleared when an option is chosen. */
  pendingChoice: PendingChoice | null;
  /** Messages produced by the most recent action. */
  lastEvents: string[];
  /** Passages produced by the most recent action (cleared at the start of
   *  each act(), exactly like lastEvents). */
  lastPassages: Passage[];
  /** Per-entity world overrides (moved/removed placed entities). All sim
   *  reads — entityAt, walkability, line of sight, interact, observers —
   *  consult these. */
  entityOverrides: Record<string, EntityOverride>;
  /** Entities added at runtime by spawn_entity. */
  spawnedEntities: SpawnedEntityRecord[];
  /** Repainted tiles per map (from set_tile). */
  tileOverrides: Record<string, TileOverride[]>;
  /** "mapId:id" keys of `once` triggers that already fired. */
  firedTriggers: string[];
  /** Renderer-directed cutscene records from the most recent action
   *  (cleared each act, like lastEvents/lastPassages). */
  lastCues: Cue[];
  /** How the game ended, or null while it is still going. Any ending stops
   *  the sim the way `won` does; `won` is true iff ending.id === "victory". */
  ending: Ending | null;
  /** Forced entity variants (set_variant): entityId -> variantId. A forced
   *  variant beats when-evaluation until cleared. */
  variantOverrides: Record<string, string>;
}

/** Plain-JSON snapshot of a sim: state plus RNG state and the original seed.
 *  `Sim.fromSnapshot(game, snapshot)` restores it exactly — mid-battle too. */
export interface SimSnapshot extends SimState {
  rng: RngState;
  seed: number;
}

/** One executable frame: a command list plus who its lines attribute to
 *  (an entity id, or a "trigger:mapId:id" narrator token). */
interface Frame {
  sourceId: string;
  commands: Command[];
}

const DELTAS: Record<Direction, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

/**
 * Deterministic simulation over a validated Game. No I/O; all randomness flows
 * through a seeded Rng shared with any active Battle, so (seed + action list)
 * fully determines the state — through battles — and a full playthrough is
 * just a replayable list of strings.
 */
export class Sim {
  readonly game: Game;
  readonly seed: number;
  state: SimState;
  private grids: Record<string, string[][]>;
  private rng: Rng;
  private battleObj: Battle | null = null;
  /** The live frame stack while execFrames runs — lets a trigger fired
   *  mid-command-list queue its commands after everything pending. */
  private activeFrames: Frame[] | null = null;

  constructor(game: Game, seed = 1) {
    this.game = game;
    this.seed = seed;
    this.rng = new Rng(seed);
    this.grids = {};
    for (const [id, def] of Object.entries(game.maps)) {
      this.grids[id] = def.rows.map((r) => [...r]);
    }
    this.state = {
      map: game.player.map,
      playerX: game.player.x,
      playerY: game.player.y,
      flags: [],
      vars: {},
      won: false,
      turn: 0,
      // A catalog-free (narrative) game validates only with an empty party;
      // the guard keeps an unvalidated one from crashing here.
      party: game.catalog
        ? game.player.party.map((m) =>
            createCombatant(game.catalog!, m.speciesId, m.level),
          )
        : [],
      inventory: game.player.inventory.map((e) => ({ ...e })),
      money: game.player.money,
      battle: null,
      battleTrainer: null,
      pendingChoice: null,
      lastEvents: [],
      lastPassages: [],
      entityOverrides: {},
      spawnedEntities: [],
      tileOverrides: {},
      firedTriggers: [],
      lastCues: [],
      ending: null,
      variantOverrides: {},
    };
    // Game start counts as arriving on the start map: its `enter` triggers
    // fire now, their events readable in lastEvents before the first act().
    // (fromSnapshot replaces the state wholesale afterwards, so restoring a
    // save never re-fires them.)
    const events: string[] = [];
    this.fireTriggers("enter", this.state.map, events);
    this.state.lastEvents = events;
  }

  /**
   * Restore a sim from a snapshot (see `snapshot()`), including an active
   * battle and the RNG, so play continues exactly where it left off. The
   * snapshot may have crossed JSON: party/battle aliasing is re-established.
   */
  static fromSnapshot(game: Game, snapshot: SimSnapshot): Sim {
    const clone = structuredClone(snapshot);
    const sim = new Sim(game, clone.seed ?? 1);
    const { rng, seed, ...state } = clone;
    void seed;
    sim.state = state;
    sim.state.battleTrainer ??= null; // tolerate pre-trainer snapshots
    sim.state.vars ??= {}; // tolerate pre-vars snapshots
    sim.state.lastPassages ??= []; // tolerate pre-passage snapshots
    sim.state.pendingChoice ??= null; // tolerate pre-choice snapshots
    // Tolerate pre-overlay/trigger/ending/variant snapshots.
    sim.state.entityOverrides ??= {};
    sim.state.spawnedEntities ??= [];
    sim.state.tileOverrides ??= {};
    sim.state.firedTriggers ??= [];
    sim.state.lastCues ??= [];
    sim.state.ending ??= null;
    sim.state.variantOverrides ??= {};
    sim.rng = Rng.fromState(rng);
    if (sim.state.battle) {
      // The overworld party and the battle's player party are the same array
      // while a battle runs; a JSON round-trip splits them — rejoin here.
      sim.state.party = sim.state.battle.player.party;
      sim.battleObj = createBattle(game.catalog!, {
        mode: sim.state.battle.mode,
        playerParty: sim.state.battle.player.party,
        enemyParty: sim.state.battle.enemy.party,
        rng: sim.rng,
        state: sim.state.battle,
      });
    }
    return sim;
  }

  /** The active Battle instance, or null. Its state aliases `state.battle`. */
  get battle(): Battle | null {
    return this.battleObj;
  }

  /** The map definition the player is currently on. */
  get currentMap(): MapDef {
    return this.game.maps[this.state.map];
  }

  private get grid(): string[][] {
    return this.grids[this.state.map];
  }

  get width(): number {
    return this.grid[0].length;
  }
  get height(): number {
    return this.grid.length;
  }

  /** Serializable RNG state; part of what a save file must persist. */
  get rngState(): RngState {
    return this.rng.getState();
  }

  /** JSON-serializable snapshot: sim state (battle included) plus RNG state.
   *  Restore with `Sim.fromSnapshot`. */
  snapshot(): SimSnapshot {
    return {
      ...structuredClone(this.state),
      rng: this.rng.getState(),
      seed: this.seed,
    };
  }

  /** Effective tile char at (x, y) on a map: set_tile overrides first,
   *  then the static grid. */
  private tileCharAt(mapId: string, x: number, y: number): string {
    const ov = this.state.tileOverrides[mapId]?.find((t) => t.x === x && t.y === y);
    return ov ? ov.char : this.grids[mapId][y][x];
  }

  tileAt(x: number, y: number) {
    return this.game.legend[this.tileCharAt(this.state.map, x, y)];
  }

  /** Where an entity effectively is right now (overrides applied), or
   *  undefined if unknown/removed. `spawned` is set for runtime spawns. */
  private locate(
    entityId: string,
  ):
    | { base: Entity; mapId: string; x: number; y: number; spawned?: SpawnedEntityRecord }
    | undefined {
    for (const [homeId, def] of Object.entries(this.game.maps)) {
      for (const e of def.entities) {
        if (e.id !== entityId) continue;
        const o = this.state.entityOverrides[e.id];
        if (o?.removed) return undefined;
        return { base: e, mapId: o?.mapId ?? homeId, x: o?.x ?? e.x, y: o?.y ?? e.y };
      }
    }
    const spawned = this.state.spawnedEntities.find((r) => r.entity.id === entityId);
    if (spawned) {
      return {
        base: spawned.entity,
        mapId: spawned.mapId,
        x: spawned.entity.x,
        y: spawned.entity.y,
        spawned,
      };
    }
    return undefined;
  }

  /** Effective glyph/name/sprite for an entity: forced variant first
   *  (set_variant), then the first variant whose `when` passes, then base. */
  private appearance(e: Entity): { name: string; glyph: string; sprite?: string } {
    const variants = e.variants;
    if (variants && variants.length > 0) {
      const forcedId = this.state.variantOverrides[e.id];
      const v =
        (forcedId !== undefined ? variants.find((x) => x.id === forcedId) : undefined) ??
        variants.find((x) => !x.when || evalWhen(this.whenCtx(), x.when));
      if (v) {
        return {
          name: v.name ?? e.name,
          glyph: v.glyph ?? e.glyph,
          ...(v.sprite ?? e.sprite ? { sprite: v.sprite ?? e.sprite } : {}),
        };
      }
    }
    return { name: e.name, glyph: e.glyph, ...(e.sprite ? { sprite: e.sprite } : {}) };
  }

  /** Build the effective view of an entity (position + variant appearance).
   *  Returns the base object untouched when nothing applies. */
  private effectiveEntity(base: Entity, x: number, y: number): Entity {
    const a = this.appearance(base);
    if (x === base.x && y === base.y && a.name === base.name && a.glyph === base.glyph && a.sprite === base.sprite) {
      return base;
    }
    return {
      ...base,
      x,
      y,
      name: a.name,
      glyph: a.glyph,
      ...(a.sprite !== undefined ? { sprite: a.sprite } : {}),
    };
  }

  /**
   * Every entity effectively on `mapId` right now: placed entities (minus
   * removed, with position/map overrides and variant appearance applied),
   * then runtime spawns. All sim reads and observers go through this.
   */
  entitiesOn(mapId: string): Entity[] {
    const out: Entity[] = [];
    for (const [homeId, def] of Object.entries(this.game.maps)) {
      for (const e of def.entities) {
        const o = this.state.entityOverrides[e.id];
        if (o?.removed) continue;
        if ((o?.mapId ?? homeId) !== mapId) continue;
        out.push(this.effectiveEntity(e, o?.x ?? e.x, o?.y ?? e.y));
      }
    }
    for (const r of this.state.spawnedEntities) {
      if (r.mapId === mapId) out.push(this.effectiveEntity(r.entity, r.entity.x, r.entity.y));
    }
    return out;
  }

  /** Entity at (x, y) on the current map (overlays applied). */
  entityAt(x: number, y: number): Entity | undefined {
    return this.entitiesOn(this.state.map).find((e) => e.x === x && e.y === y);
  }

  /** Portal at (x, y) on the current map. */
  portalAt(x: number, y: number): Portal | undefined {
    return this.currentMap.portals.find((p) => p.x === x && p.y === y);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  private blocks(e: Entity): boolean {
    if (!e.blocking) return false;
    if (e.passableWithFlag && this.state.flags.includes(e.passableWithFlag)) return false;
    return true;
  }

  /** Human-readable list of currently valid battle action words. */
  battleActionsHint(): string {
    const b = this.state.battle;
    if (!b) return "";
    const me = b.player.party[b.player.active];
    const parts = [`move1..move${Math.max(1, me.moves.length)}`];
    if (b.player.party.length > 1) parts.push(`switch1..switch${b.player.party.length}`);
    if (this.state.inventory.length > 0)
      parts.push(`item1..item${Math.min(9, this.state.inventory.length)}`);
    if (b.mode === "wild") parts.push("catch", "run");
    return parts.join(" | ");
  }

  /** The context `when` conditions evaluate against. */
  private whenCtx(): WhenContext {
    return { flags: this.state.flags, vars: this.state.vars, money: this.state.money };
  }

  /** Whether an interaction's gates (requiresFlag/forbidsFlag sugar ANDed
   *  with `when`) all pass right now. */
  private interactionOpen(i: Interaction): boolean {
    return (
      (!i.requiresFlag || this.state.flags.includes(i.requiresFlag)) &&
      (!i.forbidsFlag || !this.state.flags.includes(i.forbidsFlag)) &&
      (!i.when || evalWhen(this.whenCtx(), i.when))
    );
  }

  act(action: Action): string[] {
    const events: string[] = [];
    this.state.lastPassages = [];
    this.state.lastCues = [];
    if (this.state.won) {
      events.push("The game is already won. Reset to play again.");
      this.state.lastEvents = events;
      return events;
    }
    if (this.state.ending) {
      events.push("The game has ended. Reset to play again.");
      this.state.lastEvents = events;
      return events;
    }
    const isBattleAction = action.type.startsWith("battle_");
    // A pending choice locks the sim to `choose` (battle is always null here:
    // choices only arise from overworld interactions and block movement).
    if (this.state.pendingChoice && action.type !== "choose") {
      const n = this.state.pendingChoice.options.length;
      events.push(`A choice is before you — pick an option: choose1..choose${n}.`);
      this.state.lastEvents = events;
      return events;
    }
    if (this.state.battle && !isBattleAction) {
      events.push(`You are in a battle — valid actions: ${this.battleActionsHint()}.`);
      this.state.lastEvents = events;
      return events;
    }
    if (!this.state.battle && isBattleAction) {
      events.push(
        "There is no battle right now — valid actions: north | south | east | west | interact.",
      );
      this.state.lastEvents = events;
      return events;
    }
    if (!this.state.pendingChoice && action.type === "choose") {
      events.push(
        "There is no choice to make right now — valid actions: north | south | east | west | interact.",
      );
      this.state.lastEvents = events;
      return events;
    }
    this.state.turn += 1;
    // Whether this action actually advanced the world — a rejected move or an
    // interact with nothing to talk to does not tick `turn` triggers.
    let advanced = false;
    switch (action.type) {
      case "move":
        advanced = this.doMove(action.dir, events);
        break;
      case "interact":
        advanced = this.doInteract(events);
        break;
      case "choose":
        advanced = this.doChoose(action.index, events);
        break;
      default:
        this.doBattleAction(action, events);
        break;
    }
    // `turn` triggers fire last, once per world action, and only with the
    // world in a settled state: no battle running, no choice still open (the
    // beat that opened it ticks when the player answers).
    if (advanced && !this.state.battle && !this.state.pendingChoice) {
      this.fireTriggers("turn", this.state.map, events);
    }
    this.state.lastEvents = events;
    return events;
  }

  /** Returns whether the player actually moved (a blocked move does not tick). */
  private doMove(dir: Direction, events: string[]): boolean {
    const [dx, dy] = DELTAS[dir];
    const nx = this.state.playerX + dx;
    const ny = this.state.playerY + dy;
    if (!this.inBounds(nx, ny)) {
      events.push(`You can't go ${dir} — the edge of the world.`);
      return false;
    }
    const tile = this.tileAt(nx, ny);
    if (!tile.walkable) {
      events.push(`You can't go ${dir} — ${tile.name} blocks the way.`);
      return false;
    }
    const entity = this.entityAt(nx, ny);
    if (entity && this.blocks(entity)) {
      events.push(`${entity.name} is standing there. Try "interact".`);
      return false;
    }
    if (tile.wild && this.game.catalog) {
      if (this.state.party.length === 0) {
        events.push("You shouldn't step into the tall grass without a kindred.");
        return false;
      }
      if (this.state.party.every((c) => c.hp <= 0)) {
        events.push("Your kindred are too weary for the tall grass — rest them first.");
        return false;
      }
    }
    this.state.playerX = nx;
    this.state.playerY = ny;
    events.push(`You move ${dir}.`);

    const portal = this.portalAt(nx, ny);
    if (portal) {
      this.state.map = portal.toMap;
      this.state.playerX = portal.toX;
      this.state.playerY = portal.toY;
      events.push(`You enter ${portal.toMap}.`);
    } else {
      const zone = this.currentMap.encounters;
      if (tile.wild && zone && this.game.catalog && this.rng.chance(zone.rate)) {
        const entry = this.rng.pickWeighted(zone.table);
        const level = this.rng.int(entry.minLevel, entry.maxLevel);
        const enemy = createCombatant(this.game.catalog!, entry.speciesId, level);
        this.battleObj = createBattle(this.game.catalog!, {
          mode: "wild",
          playerParty: this.state.party,
          enemyParty: [enemy],
          rng: this.rng,
        });
        this.state.battle = this.battleObj.state;
        const species = speciesById(this.game.catalog!, entry.speciesId);
        events.push(`A wild ${species.name} (Lv ${level}) appears!`);
      }
    }

    // Trainer line-of-sight: checked after the move fully settles (portal
    // transfers included), unless a wild battle already started.
    if (!this.state.battle) this.checkTrainerSight(events);

    // Triggers fire only if no battle engaged this move (a `once` trigger on
    // a tile that also starts a battle stays unfired for a later visit).
    // `enter` fires on portal arrival; `step` fires for the landing tile —
    // unless an enter trigger already relocated the player away from it.
    if (!this.state.battle) {
      const landedMap = this.state.map;
      const landedX = this.state.playerX;
      const landedY = this.state.playerY;
      if (portal) this.fireTriggers("enter", landedMap, events);
      if (
        this.state.map === landedMap &&
        this.state.playerX === landedX &&
        this.state.playerY === landedY
      ) {
        this.fireTriggers("step", landedMap, events, { x: landedX, y: landedY });
      }
    }
    return true;
  }

  /**
   * Fire a map's matching triggers. Gates: `once` (skipped if already in
   * firedTriggers), `when` (skipped WITHOUT marking fired, so it can fire
   * later). Firing triggers are marked first, then their command lists run
   * through the execFrames pipeline in definition order. A trigger firing
   * while commands are already pending — mid-command-list (teleport_player)
   * or mid-choice — queues its commands after ALL currently pending work.
   */
  private fireTriggers(
    on: "enter" | "step" | "turn",
    mapId: string,
    events: string[],
    tile?: { x: number; y: number },
  ): void {
    if (this.state.won || this.state.ending) return;
    const def = this.game.maps[mapId];
    if (!def) return;
    const fired: { sourceId: string; commands: Command[] }[] = [];
    for (const t of def.triggers ?? []) {
      if (t.on !== on) continue;
      if (on === "step" && !(t.tiles ?? []).some((p) => p.x === tile!.x && p.y === tile!.y)) {
        continue;
      }
      const key = `${mapId}:${t.id}`;
      if (t.once && this.state.firedTriggers.includes(key)) continue;
      if (t.when && !evalWhen(this.whenCtx(), t.when)) continue;
      if (t.once) this.state.firedTriggers.push(key);
      fired.push({ sourceId: `trigger:${key}`, commands: [...t.commands] });
    }
    if (fired.length === 0) return;
    // execFrames runs the LAST frame first, so reverse to keep definition
    // order; queued-after frames go to the FRONT (outermost = runs last).
    const frames: Frame[] = fired.reverse();
    if (this.activeFrames) {
      this.activeFrames.unshift(...frames);
    } else if (this.state.pendingChoice) {
      const pc = this.state.pendingChoice;
      pc.continuationSources ??= pc.continuations.map(() => pc.sourceId);
      pc.continuations.unshift(...frames.map((f) => f.commands));
      pc.continuationSources.unshift(...frames.map((f) => f.sourceId));
    } else {
      this.execFrames(frames, events);
    }
  }

  /** Effective entity lookup across every map (ids are unique game-wide).
   *  Overlays and variants applied; removed entities return undefined. */
  private entityById(id: string): Entity | undefined {
    const loc = this.locate(id);
    return loc ? this.effectiveEntity(loc.base, loc.x, loc.y) : undefined;
  }

  /** An undefeated trainer battles on sight down a clear straight line. */
  private checkTrainerSight(events: string[]): void {
    if (!this.game.catalog) return; // narrative game: battles never engage
    const { playerX: px, playerY: py } = this.state;
    for (const e of this.entitiesOn(this.state.map)) {
      const t = e.trainer;
      if (!t?.lineOfSight || this.state.flags.includes(t.defeatFlag)) continue;
      const [dx, dy] = DELTAS[t.lineOfSight.dir];
      // Distance k >= 1 such that the player stands k tiles along dir.
      let k = -1;
      if (dx !== 0 && py === e.y && (px - e.x) * dx > 0) k = (px - e.x) * dx;
      if (dy !== 0 && px === e.x && (py - e.y) * dy > 0) k = (py - e.y) * dy;
      if (k < 1 || k > t.lineOfSight.range) continue;
      let blocked = false;
      for (let i = 1; i < k && !blocked; i++) {
        const x = e.x + dx * i;
        const y = e.y + dy * i;
        if (!this.tileAt(x, y).walkable) blocked = true;
        const between = this.entityAt(x, y);
        if (between && this.blocks(between)) blocked = true;
      }
      if (blocked) continue;
      events.push(`${e.name} spots you!`);
      this.startTrainerBattle(e, events);
      return;
    }
  }

  /** Begin a trainer battle (or explain why it can't start). */
  private startTrainerBattle(e: Entity, events: string[]): void {
    const t = e.trainer!;
    if (this.state.party.length === 0 || this.state.party.every((c) => c.hp <= 0)) {
      events.push(
        `${e.name} looks you over. "No kindred fit to battle — come back when yours are ready."`,
      );
      return;
    }
    if (t.intro) events.push(`${e.name}: "${t.intro}"`);
    events.push(`${e.name} challenges you to battle!`);
    const enemyParty = t.party.map((m) =>
      createCombatant(this.game.catalog!, m.speciesId, m.level),
    );
    this.battleObj = createBattle(this.game.catalog!, {
      mode: "trainer",
      playerParty: this.state.party,
      enemyParty,
      rng: this.rng,
    });
    this.state.battle = this.battleObj.state;
    this.state.battleTrainer = e.id;
  }

  /** First inventory slot holding a capture item, or -1. */
  private firstCaptureSlot(): number {
    return this.state.inventory.findIndex(
      (e) => itemById(this.game.catalog!, e.itemId).kind === "capture",
    );
  }

  private consumeItem(slot: number): Item {
    const entry = this.state.inventory[slot];
    const item = itemById(this.game.catalog!, entry.itemId);
    entry.qty -= 1;
    if (entry.qty <= 0) this.state.inventory.splice(slot, 1);
    return item;
  }

  private addItem(itemId: string, qty: number): void {
    const existing = this.state.inventory.find((e) => e.itemId === itemId);
    if (existing) existing.qty += qty;
    else this.state.inventory.push({ itemId, qty });
  }

  private doBattleAction(
    action: Exclude<Action, { type: "move" } | { type: "interact" } | { type: "choose" }>,
    events: string[],
  ): void {
    const battle = this.battleObj!;
    const routed: PlayerAction | null = this.toBattleAction(battle, action, events);
    if (routed) events.push(...battle.act(routed));
    this.settleBattle(events);
  }

  /**
   * Translate a sim battle action into a Battle action, resolving inventory.
   * Returns null when the action already failed sim-side (event pushed, no
   * item consumed, no battle turn spent).
   */
  private toBattleAction(
    battle: Battle,
    action: Exclude<Action, { type: "move" } | { type: "interact" } | { type: "choose" }>,
    events: string[],
  ): PlayerAction | null {
    switch (action.type) {
      case "battle_move":
        return { type: "move", index: action.index };
      case "battle_switch":
        return { type: "switch", index: action.index };
      case "battle_run":
        return { type: "run" };
      case "battle_catch": {
        // Let the battle itself reject illegal contexts (no item consumed).
        if (battle.state.needsSwitch || battle.state.mode === "trainer") {
          return { type: "catch", name: "snare", ballMod: 1 };
        }
        const slot = this.firstCaptureSlot();
        if (slot === -1) {
          events.push("You have nothing to catch with — you need a capture item.");
          return null;
        }
        const item = this.consumeItem(slot);
        return { type: "catch", name: item.name, ballMod: item.ballMod! };
      }
      case "battle_item": {
        if (battle.state.needsSwitch) {
          return { type: "item", name: "nothing", heal: 0 }; // rejected: must switch
        }
        const entry = this.state.inventory[action.index];
        if (!entry) {
          const n = this.state.inventory.length;
          events.push(
            n === 0
              ? "You aren't carrying any items."
              : `There is no item in slot ${action.index + 1} — valid: item1..item${n}.`,
          );
          return null;
        }
        const item = itemById(this.game.catalog!, entry.itemId);
        if (item.kind === "capture") {
          if (battle.state.mode === "trainer") {
            return { type: "catch", name: item.name, ballMod: 1 }; // rejected by battle
          }
          this.consumeItem(action.index);
          return { type: "catch", name: item.name, ballMod: item.ballMod! };
        }
        this.consumeItem(action.index);
        return { type: "item", name: item.name, heal: item.amount! };
      }
    }
  }

  /** Fold a finished battle back into the overworld. */
  private settleBattle(events: string[]): void {
    const battle = this.battleObj;
    if (!battle || battle.state.outcome === "ongoing") return;
    const outcome = battle.state.outcome;

    if (outcome === "captured") {
      const caught = battle.state.enemy.party[battle.state.enemy.active];
      const species = speciesById(this.game.catalog!, caught.speciesId);
      if (this.state.party.length < 6) {
        this.state.party.push(caught);
        events.push(`${species.name} joined your party!`);
      } else {
        events.push(
          `Your party is full — you let the ${species.name} slip back into the grass, unhurried.`,
        );
      }
    }

    if (outcome === "player_won" && this.state.battleTrainer) {
      const trainerEntity = this.entityById(this.state.battleTrainer);
      const t = trainerEntity?.trainer;
      if (trainerEntity && t) {
        if (!this.state.flags.includes(t.defeatFlag)) {
          this.state.flags.push(t.defeatFlag);
        }
        if (t.rewardMoney) {
          this.state.money += t.rewardMoney;
          events.push(`You won ${t.rewardMoney} coins!`);
        }
        for (const cmd of t.rewardCommands ?? []) {
          // `choice` is overworld-only (validateGame errors on it here);
          // skip defensively for unvalidated games.
          if (cmd.type === "choice") continue;
          this.runCommand(trainerEntity, cmd, events);
        }
        if (t.defeatText) events.push(`${trainerEntity.name}: "${t.defeatText}"`);
      }
    }

    if (outcome === "enemy_won") {
      this.healParty();
      this.state.money = Math.floor(this.state.money / 2);
      const r = this.game.player.respawn ?? {
        map: this.game.player.map,
        x: this.game.player.x,
        y: this.game.player.y,
      };
      this.state.map = r.map;
      this.state.playerX = r.x;
      this.state.playerY = r.y;
      events.push(
        "Everything goes quiet for a moment. You wake by the hearth, your kindred warm beside you.",
      );
    }

    this.checkEvolutions(events);
    this.battleObj = null;
    this.state.battle = null;
    this.state.battleTrainer = null;
  }

  /** Evolution check — runs whenever a battle ends, never mid-battle. */
  private checkEvolutions(events: string[]): void {
    for (const c of this.state.party) {
      let species = speciesById(this.game.catalog!, c.speciesId);
      while (species.evolvesTo && c.level >= species.evolvesTo.level) {
        const next = speciesById(this.game.catalog!, species.evolvesTo.speciesId);
        const hpFraction = c.maxHp > 0 ? c.hp / c.maxHp : 1;
        const stats = statsAtLevel(next, c.level);
        c.speciesId = next.id;
        c.maxHp = stats.hp;
        c.atk = stats.atk;
        c.def = stats.def;
        c.spd = stats.spd;
        c.hp = c.hp <= 0 ? 0 : Math.max(1, Math.round(stats.hp * hpFraction));
        events.push(`${species.name}'s flame steadies. It is ${next.name} now.`);
        species = next;
      }
    }
  }

  private healParty(): void {
    for (const c of this.state.party) {
      c.hp = c.maxHp;
      for (const slot of c.moves) {
        slot.pp = moveById(this.game.catalog!, slot.moveId).pp;
      }
    }
  }

  /** Returns whether an interaction actually ran (nothing to talk to, or an
   *  entity with nothing to say, does not tick `turn` triggers). */
  private doInteract(events: string[]): boolean {
    const { playerX: px, playerY: py } = this.state;
    const adjacent = this.entitiesOn(this.state.map).find(
      (e) => Math.abs(e.x - px) + Math.abs(e.y - py) === 1,
    );
    if (!adjacent) {
      events.push("There is nothing next to you to interact with.");
      return false;
    }
    // An undefeated trainer battles instead of chatting (catalog games only).
    if (
      adjacent.trainer &&
      this.game.catalog &&
      !this.state.flags.includes(adjacent.trainer.defeatFlag)
    ) {
      this.startTrainerBattle(adjacent, events);
      return true;
    }
    const interaction = adjacent.interactions.find((i) => this.interactionOpen(i));
    if (!interaction) {
      // Defeated trainers fall back to their outro line.
      if (adjacent.trainer?.outro) {
        events.push(`${adjacent.name}: "${adjacent.trainer.outro}"`);
        return true;
      }
      events.push(`${adjacent.name} has nothing to say.`);
      return false;
    }
    this.execFrames([{ sourceId: adjacent.id, commands: [...interaction.commands] }], events);
    return true;
  }

  /** Resolve a pending choice: clear it, run the chosen option's commands,
   *  then resume the suspended continuations (innermost first). Returns
   *  whether a choice was actually resolved (an out-of-range index is a
   *  rejected action and does not tick `turn` triggers). */
  private doChoose(index: number, events: string[]): boolean {
    const pending = this.state.pendingChoice!;
    const n = pending.options.length;
    if (index < 0 || index >= n) {
      events.push(
        `There is no option ${index + 1} — valid: choose1..choose${n}.`,
      );
      return false;
    }
    const option = pending.options[index];
    this.state.pendingChoice = null;
    events.push(`You choose: ${option.label}`);
    const frames: Frame[] = [
      ...pending.continuations.map((c, i) => ({
        // Older snapshots lack continuationSources: fall back to sourceId.
        sourceId: pending.continuationSources?.[i] ?? pending.sourceId,
        commands: [...c],
      })),
      { sourceId: pending.sourceId, commands: [...option.commands] },
    ];
    this.execFrames(frames, events);
    return true;
  }

  /**
   * Run a stack of command lists (last frame = innermost, executed first).
   * A `choice` command SUSPENDS execution: the remaining commands of every
   * frame become the pending choice's continuations and resume after the
   * chosen option's commands complete. Nested choices restack the same way —
   * bounded by data, no recursion. Frames are consumed destructively, so
   * callers pass fresh arrays (command objects themselves are never mutated).
   */
  private execFrames(frames: Frame[], events: string[]): void {
    // Expose the live frame stack so a trigger firing mid-command-list
    // (teleport_player) can queue its commands after everything pending.
    const prevActive = this.activeFrames;
    this.activeFrames = frames;
    try {
      this.runFrames(frames, events);
    } finally {
      this.activeFrames = prevActive;
    }
  }

  /** Who `say` (and further choices) attribute to. Trigger-sourced commands
   *  speak with the narrator's (empty) name: say prints the bare text.
   *  Resolved per command so variant-name changes show up mid-sequence. */
  private resolveSource(sourceId: string): Entity {
    if (sourceId.startsWith("trigger:")) {
      return { id: sourceId, name: "", glyph: "", x: 0, y: 0, blocking: false, interactions: [] };
    }
    return (
      this.entityById(sourceId) ??
      // Defensive: a save from an edited game may name a removed entity.
      ({ id: sourceId, name: "Someone", glyph: "?", x: 0, y: 0, blocking: true, interactions: [] } as Entity)
    );
  }

  private runFrames(frames: Frame[], events: string[]): void {
    while (frames.length > 0) {
      if (this.state.won || this.state.ending) return;
      const top = frames[frames.length - 1];
      const cmd = top.commands.shift();
      if (!cmd) {
        frames.pop();
        continue;
      }
      if (cmd.type === "choice") {
        if (cmd.when && !evalWhen(this.whenCtx(), cmd.when)) continue;
        const open = cmd.options.filter(
          (o) => !o.when || evalWhen(this.whenCtx(), o.when),
        );
        if (open.length === 0) {
          events.push(
            `${cmd.prompt} — but none of the options are open to you right now.`,
          );
          continue;
        }
        const suspended = frames.filter((f) => f.commands.length > 0);
        this.state.pendingChoice = {
          sourceId: top.sourceId,
          prompt: cmd.prompt,
          options: open.map((o) => ({ label: o.label, commands: [...o.commands] })),
          continuations: suspended.map((f) => [...f.commands]),
          continuationSources: suspended.map((f) => f.sourceId),
        };
        events.push(cmd.prompt);
        open.forEach((o, i) => events.push(`${i + 1}) ${o.label}`));
        events.push(`Choose an option: choose1..choose${open.length}.`);
        return;
      }
      this.runCommand(this.resolveSource(top.sourceId), cmd, events);
    }
  }

  /** Run one non-choice command (choice is handled by execFrames; trainer
   *  rewardCommands may not contain it — validation errors battle-side). */
  private runCommand(
    source: Entity,
    cmd: Exclude<Command, { type: "choice" }>,
    events: string[],
  ): void {
    // Every command shares the optional `when` gate: skipped silently when false.
    if (cmd.when && !evalWhen(this.whenCtx(), cmd.when)) return;
    switch (cmd.type) {
      case "say":
        // Trigger-sourced (narrator) lines print bare — there is no speaker.
        events.push(source.name ? `${source.name}: "${cmd.text}"` : cmd.text);
        break;
      case "set_flag":
        if (!this.state.flags.includes(cmd.flag)) {
          this.state.flags.push(cmd.flag);
        }
        break;
      case "set_var":
        this.state.vars[cmd.var] = cmd.value;
        break;
      case "add_var": {
        const current = this.state.vars[cmd.var] ?? 0;
        if (typeof current !== "number") {
          events.push(
            `Nothing happens — "${cmd.var}" holds text ("${current}"), not a number.`,
          );
          break;
        }
        this.state.vars[cmd.var] = current + cmd.amount;
        break;
      }
      case "passage": {
        const passage: Passage = { lines: [...cmd.lines] };
        if (cmd.title !== undefined) passage.title = cmd.title;
        if (cmd.citation !== undefined) passage.citation = cmd.citation;
        this.state.lastPassages.push(passage);
        const parts: string[] = [];
        if (cmd.title !== undefined) parts.push(cmd.title, "");
        parts.push(...cmd.lines);
        if (cmd.citation !== undefined) parts.push(`— ${cmd.citation}`);
        events.push(parts.join("\n"));
        break;
      }
      case "give_species": {
        const species = speciesById(this.game.catalog!, cmd.speciesId);
        if (this.state.party.length >= 6) {
          events.push(`Your party is full — ${species.name} stays with ${source.name}.`);
          break;
        }
        this.state.party.push(
          createCombatant(this.game.catalog!, cmd.speciesId, cmd.level),
        );
        events.push(`${species.name} (Lv ${cmd.level}) joins your party!`);
        break;
      }
      case "give_item": {
        const item = itemById(this.game.catalog!, cmd.itemId);
        this.addItem(cmd.itemId, cmd.qty);
        events.push(`You received ${cmd.qty}x ${item.name}.`);
        break;
      }
      case "give_money":
        this.state.money += cmd.amount;
        events.push(`You received ${cmd.amount} coins.`);
        break;
      case "heal_party":
        if (!this.game.catalog) {
          // Narrative game: no party to heal — a gentle no-op.
          events.push("You rest a while by the warmth.");
          break;
        }
        this.healParty();
        events.push("Your kindred are rested and warm again.");
        break;
      case "sell": {
        const item = itemById(this.game.catalog!, cmd.itemId);
        const article = /^[aeiou]/i.test(item.name) ? "an" : "a";
        if (this.state.money < cmd.price) {
          events.push(
            `You can't afford ${article} ${item.name} — it costs ${cmd.price} and you have ${this.state.money} (${cmd.price - this.state.money} short).`,
          );
          break;
        }
        this.state.money -= cmd.price;
        this.addItem(cmd.itemId, 1);
        events.push(`Bought ${article} ${item.name} for ${cmd.price}.`);
        break;
      }
      case "win":
        // Sugar for end { id: "victory" } — events pinned for back-compat.
        this.state.won = true;
        this.state.ending = { id: "victory", text: cmd.text };
        events.push(cmd.text);
        events.push("*** YOU WIN ***");
        break;
      case "end":
        this.state.ending = { id: cmd.id, text: cmd.text };
        this.state.won = cmd.id === "victory";
        events.push(cmd.text);
        events.push(
          cmd.id === "victory" ? "*** YOU WIN ***" : `*** THE END — ${cmd.id} ***`,
        );
        break;
      case "teleport_player": {
        const rows = this.grids[cmd.mapId];
        if (!rows) {
          events.push(`Nothing happens — there is no map "${cmd.mapId}".`);
          break;
        }
        if (cmd.y < 0 || cmd.y >= rows.length || cmd.x < 0 || cmd.x >= rows[0].length) {
          events.push(
            `Nothing happens — (${cmd.x}, ${cmd.y}) is outside map "${cmd.mapId}".`,
          );
          break;
        }
        this.state.map = cmd.mapId;
        this.state.playerX = cmd.x;
        this.state.playerY = cmd.y;
        events.push(`You find yourself in ${cmd.mapId}.`);
        // Teleport arrival fires the target map's enter triggers; when this
        // runs mid-command-list they queue after all pending commands.
        this.fireTriggers("enter", cmd.mapId, events);
        break;
      }
      case "show_title":
        this.state.lastCues.push({
          kind: "show_title",
          text: cmd.text,
          ...(cmd.subtitle !== undefined ? { subtitle: cmd.subtitle } : {}),
        });
        events.push(
          cmd.subtitle !== undefined ? `— ${cmd.text} —\n${cmd.subtitle}` : `— ${cmd.text} —`,
        );
        break;
      case "move_entity": {
        const loc = this.locate(cmd.entityId);
        if (!loc) {
          events.push(`Nothing happens — no entity "${cmd.entityId}" is present.`);
          break;
        }
        const name = this.appearance(loc.base).name;
        const from = { x: loc.x, y: loc.y };
        let { x, y } = from;
        const steps: Direction[] = [];
        let blocked: Direction | undefined;
        for (const dir of cmd.path) {
          const [dx, dy] = DELTAS[dir];
          if (!this.entityCanStep(loc.mapId, x + dx, y + dy, cmd.entityId)) {
            blocked = dir;
            break;
          }
          x += dx;
          y += dy;
          steps.push(dir);
        }
        if (steps.length > 0) this.placeEntityAt(loc, x, y);
        this.state.lastCues.push({
          kind: "move_entity",
          entityId: cmd.entityId,
          mapId: loc.mapId,
          from,
          to: { x, y },
          steps,
          ...(blocked !== undefined ? { blocked } : {}),
        });
        if (cmd.quiet !== true) {
          if (steps.length > 0) events.push(`${name} moves ${steps.join(", ")}.`);
          if (blocked !== undefined) {
            events.push(`${name} stops — the way ${blocked} is blocked.`);
          }
        }
        break;
      }
      case "spawn_entity": {
        const mapId = cmd.mapId ?? this.state.map;
        const rows = this.grids[mapId];
        const e = cmd.entity;
        if (!rows) {
          events.push(`Nothing happens — there is no map "${mapId}".`);
          break;
        }
        const idTaken =
          Object.values(this.game.maps).some((d) => d.entities.some((s) => s.id === e.id)) ||
          this.state.spawnedEntities.some((r) => r.entity.id === e.id);
        if (idTaken) {
          events.push(`Nothing happens — an entity with id "${e.id}" already exists.`);
          break;
        }
        if (e.y < 0 || e.y >= rows.length || e.x < 0 || e.x >= rows[0].length) {
          events.push(`Nothing happens — (${e.x}, ${e.y}) is outside map "${mapId}".`);
          break;
        }
        const occupied =
          this.entitiesOn(mapId).some((s) => s.x === e.x && s.y === e.y) ||
          (this.state.map === mapId && this.state.playerX === e.x && this.state.playerY === e.y);
        if (occupied) {
          events.push(
            `Nothing happens — (${e.x}, ${e.y}) on "${mapId}" is already occupied.`,
          );
          break;
        }
        this.state.spawnedEntities.push({ mapId, entity: structuredClone(e) });
        this.state.lastCues.push({
          kind: "spawn_entity",
          entityId: e.id,
          mapId,
          x: e.x,
          y: e.y,
          glyph: e.glyph,
        });
        events.push(`${e.name} appears.`);
        break;
      }
      case "remove_entity": {
        const loc = this.locate(cmd.entityId);
        if (!loc) {
          events.push(`Nothing happens — no entity "${cmd.entityId}" is present.`);
          break;
        }
        const name = this.appearance(loc.base).name;
        if (loc.spawned) {
          this.state.spawnedEntities.splice(
            this.state.spawnedEntities.indexOf(loc.spawned),
            1,
          );
        } else {
          this.state.entityOverrides[cmd.entityId] = {
            ...this.state.entityOverrides[cmd.entityId],
            removed: true,
          };
        }
        this.state.lastCues.push({
          kind: "remove_entity",
          entityId: cmd.entityId,
          mapId: loc.mapId,
          x: loc.x,
          y: loc.y,
        });
        events.push(`${name} departs.`);
        break;
      }
      case "set_tile": {
        const mapId = cmd.mapId ?? this.state.map;
        const rows = this.grids[mapId];
        if (!rows) {
          events.push(`Nothing happens — there is no map "${mapId}".`);
          break;
        }
        if (cmd.y < 0 || cmd.y >= rows.length || cmd.x < 0 || cmd.x >= rows[0].length) {
          events.push(`Nothing happens — (${cmd.x}, ${cmd.y}) is outside map "${mapId}".`);
          break;
        }
        const next = this.game.legend[cmd.char];
        if (!next) {
          events.push(`Nothing happens — "${cmd.char}" is not in the legend.`);
          break;
        }
        const prev = this.game.legend[this.tileCharAt(mapId, cmd.x, cmd.y)];
        const list = (this.state.tileOverrides[mapId] ??= []);
        const existing = list.find((t) => t.x === cmd.x && t.y === cmd.y);
        if (existing) existing.char = cmd.char;
        else list.push({ x: cmd.x, y: cmd.y, char: cmd.char });
        this.state.lastCues.push({ kind: "set_tile", mapId, x: cmd.x, y: cmd.y, char: cmd.char });
        events.push(`The ${prev.name} becomes ${next.name}.`);
        break;
      }
      case "wait":
        this.state.lastCues.push({ kind: "wait", beats: cmd.beats });
        events.push("…");
        break;
      case "camera_focus": {
        if (cmd.release) {
          this.state.lastCues.push({ kind: "camera_focus", release: true });
          events.push("The scene returns to you.");
        } else if (cmd.entityId !== undefined) {
          const loc = this.locate(cmd.entityId);
          if (!loc) {
            events.push(`Nothing happens — no entity "${cmd.entityId}" is present.`);
            break;
          }
          this.state.lastCues.push({
            kind: "camera_focus",
            entityId: cmd.entityId,
            mapId: loc.mapId,
            x: loc.x,
            y: loc.y,
          });
          events.push(`The scene turns to ${this.appearance(loc.base).name}.`);
        } else if (cmd.x !== undefined && cmd.y !== undefined) {
          const mapId = cmd.mapId ?? this.state.map;
          this.state.lastCues.push({ kind: "camera_focus", mapId, x: cmd.x, y: cmd.y });
          events.push(`The scene turns to ${mapId} (${cmd.x}, ${cmd.y}).`);
        } else {
          // Malformed in an unvalidated game — validateGame errors statically.
          events.push("Nothing happens — camera_focus needs a target.");
        }
        break;
      }
      case "play_music":
        this.state.lastCues.push({ kind: "play_music", track: cmd.track });
        events.push(`♪ ${cmd.track}`);
        break;
      case "screen_effect": {
        this.state.lastCues.push({ kind: "screen_effect", effect: cmd.effect });
        const line = {
          shake: "The world shakes.",
          flash: "A blinding flash!",
          fade: "Everything fades.",
        }[cmd.effect];
        events.push(line);
        break;
      }
      case "set_variant": {
        const loc = this.locate(cmd.entityId);
        if (!loc) {
          events.push(`Nothing happens — no entity "${cmd.entityId}" is present.`);
          break;
        }
        if (cmd.clear) {
          delete this.state.variantOverrides[cmd.entityId];
          break;
        }
        if (cmd.variantId === undefined) break; // malformed; validated statically
        if (!(loc.base.variants ?? []).some((v) => v.id === cmd.variantId)) {
          events.push(
            `Nothing happens — "${cmd.variantId}" is not a variant of "${cmd.entityId}".`,
          );
          break;
        }
        this.state.variantOverrides[cmd.entityId] = cmd.variantId;
        break;
      }
    }
  }

  /** Whether an entity walking a cutscene path may step onto (x, y):
   *  in bounds, walkable (tile overrides included), and not occupied by any
   *  other entity or the player. */
  private entityCanStep(mapId: string, x: number, y: number, selfId: string): boolean {
    const rows = this.grids[mapId];
    if (!rows || y < 0 || y >= rows.length || x < 0 || x >= rows[0].length) return false;
    if (!this.game.legend[this.tileCharAt(mapId, x, y)].walkable) return false;
    if (this.state.map === mapId && this.state.playerX === x && this.state.playerY === y) {
      return false;
    }
    return !this.entitiesOn(mapId).some((e) => e.id !== selfId && e.x === x && e.y === y);
  }

  /** Record an entity's new position: spawned entities mutate their record,
   *  placed entities get an overlay entry. */
  private placeEntityAt(
    loc: { base: Entity; spawned?: SpawnedEntityRecord },
    x: number,
    y: number,
  ): void {
    if (loc.spawned) {
      loc.spawned.entity.x = x;
      loc.spawned.entity.y = y;
    } else {
      this.state.entityOverrides[loc.base.id] = {
        ...this.state.entityOverrides[loc.base.id],
        x,
        y,
      };
    }
  }
}

/**
 * Parse a compact action string. Overworld: "north"/"n", "interact"/"i", ...
 * Pending choice: "choose1".."choose9" (or "o1".."o9" — o for option; "c" is
 * taken by catch). Battle: "move1".."move4" (or "m1".."m4"),
 * "switch1".."switch6" (or "s1".."s6" — bare "s" still means south),
 * "item1".."item9", "catch" (alias "snare"), "run".
 */
export function parseAction(input: string): Action | undefined {
  const word = input.trim().toLowerCase();
  const dirs: Record<string, Direction> = {
    north: "north", n: "north", up: "north",
    south: "south", s: "south", down: "south",
    east: "east", e: "east", right: "east",
    west: "west", w: "west", left: "west",
  };
  if (dirs[word]) return { type: "move", dir: dirs[word] };
  if (word === "interact" || word === "i" || word === "talk") return { type: "interact" };
  if (word === "run") return { type: "battle_run" };
  if (word === "catch" || word === "snare") return { type: "battle_catch" };
  let m = /^(?:move|m)([1-4])$/.exec(word);
  if (m) return { type: "battle_move", index: Number(m[1]) - 1 };
  m = /^(?:switch|s)([1-6])$/.exec(word);
  if (m) return { type: "battle_switch", index: Number(m[1]) - 1 };
  m = /^item([1-9])$/.exec(word);
  if (m) return { type: "battle_item", index: Number(m[1]) - 1 };
  m = /^(?:choose|o)([1-9])$/.exec(word);
  if (m) return { type: "choose", index: Number(m[1]) - 1 };
  return undefined;
}
