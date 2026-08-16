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

/**
 * A `choice` command awaiting resolution. While non-null, the sim accepts
 * ONLY `{ type: "choose", index }`. Only the options whose `when` passed at
 * presentation time are here (order preserved). `continuations` holds the
 * command lists the choice suspended (outermost first, innermost last): the
 * chosen option's commands run first, then continuations resume innermost
 * first. Everything is plain JSON — snapshot/restore works mid-choice.
 */
export interface PendingChoice {
  /** Entity id whose interaction produced the choice (say lines and further
   *  choices attribute to it; ids are unique game-wide). */
  sourceId: string;
  prompt: string;
  options: PendingChoiceOption[];
  continuations: Command[][];
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
}

/** Plain-JSON snapshot of a sim: state plus RNG state and the original seed.
 *  `Sim.fromSnapshot(game, snapshot)` restores it exactly — mid-battle too. */
export interface SimSnapshot extends SimState {
  rng: RngState;
  seed: number;
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
    };
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

  tileAt(x: number, y: number) {
    return this.game.legend[this.grid[y][x]];
  }

  /** Entity at (x, y) on the current map. */
  entityAt(x: number, y: number): Entity | undefined {
    return this.currentMap.entities.find((e) => e.x === x && e.y === y);
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
    if (this.state.won) {
      events.push("The game is already won. Reset to play again.");
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
    switch (action.type) {
      case "move":
        this.doMove(action.dir, events);
        break;
      case "interact":
        this.doInteract(events);
        break;
      case "choose":
        this.doChoose(action.index, events);
        break;
      default:
        this.doBattleAction(action, events);
        break;
    }
    this.state.lastEvents = events;
    return events;
  }

  private doMove(dir: Direction, events: string[]): void {
    const [dx, dy] = DELTAS[dir];
    const nx = this.state.playerX + dx;
    const ny = this.state.playerY + dy;
    if (!this.inBounds(nx, ny)) {
      events.push(`You can't go ${dir} — the edge of the world.`);
      return;
    }
    const tile = this.tileAt(nx, ny);
    if (!tile.walkable) {
      events.push(`You can't go ${dir} — ${tile.name} blocks the way.`);
      return;
    }
    const entity = this.entityAt(nx, ny);
    if (entity && this.blocks(entity)) {
      events.push(`${entity.name} is standing there. Try "interact".`);
      return;
    }
    if (tile.wild && this.game.catalog) {
      if (this.state.party.length === 0) {
        events.push("You shouldn't step into the tall grass without a kindred.");
        return;
      }
      if (this.state.party.every((c) => c.hp <= 0)) {
        events.push("Your kindred are too weary for the tall grass — rest them first.");
        return;
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
  }

  /** Entity lookup across every map (ids are unique game-wide). */
  private entityById(id: string): Entity | undefined {
    for (const def of Object.values(this.game.maps)) {
      const found = def.entities.find((e) => e.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** An undefeated trainer battles on sight down a clear straight line. */
  private checkTrainerSight(events: string[]): void {
    if (!this.game.catalog) return; // narrative game: battles never engage
    const { playerX: px, playerY: py } = this.state;
    for (const e of this.currentMap.entities) {
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

  private doInteract(events: string[]): void {
    const { playerX: px, playerY: py } = this.state;
    const adjacent = this.currentMap.entities.find(
      (e) => Math.abs(e.x - px) + Math.abs(e.y - py) === 1,
    );
    if (!adjacent) {
      events.push("There is nothing next to you to interact with.");
      return;
    }
    // An undefeated trainer battles instead of chatting (catalog games only).
    if (
      adjacent.trainer &&
      this.game.catalog &&
      !this.state.flags.includes(adjacent.trainer.defeatFlag)
    ) {
      this.startTrainerBattle(adjacent, events);
      return;
    }
    const interaction = adjacent.interactions.find((i) => this.interactionOpen(i));
    if (!interaction) {
      // Defeated trainers fall back to their outro line.
      if (adjacent.trainer?.outro) {
        events.push(`${adjacent.name}: "${adjacent.trainer.outro}"`);
        return;
      }
      events.push(`${adjacent.name} has nothing to say.`);
      return;
    }
    this.execFrames(adjacent.id, [[...interaction.commands]], events);
  }

  /** Resolve a pending choice: clear it, run the chosen option's commands,
   *  then resume the suspended continuations (innermost first). */
  private doChoose(index: number, events: string[]): void {
    const pending = this.state.pendingChoice!;
    const n = pending.options.length;
    if (index < 0 || index >= n) {
      events.push(
        `There is no option ${index + 1} — valid: choose1..choose${n}.`,
      );
      return;
    }
    const option = pending.options[index];
    this.state.pendingChoice = null;
    events.push(`You choose: ${option.label}`);
    const frames = [
      ...pending.continuations.map((c) => [...c]),
      [...option.commands],
    ];
    this.execFrames(pending.sourceId, frames, events);
  }

  /**
   * Run a stack of command lists (last frame = innermost, executed first).
   * A `choice` command SUSPENDS execution: the remaining commands of every
   * frame become the pending choice's continuations and resume after the
   * chosen option's commands complete. Nested choices restack the same way —
   * bounded by data, no recursion. Frames are consumed destructively, so
   * callers pass fresh arrays (command objects themselves are never mutated).
   */
  private execFrames(sourceId: string, frames: Command[][], events: string[]): void {
    const source =
      this.entityById(sourceId) ??
      // Defensive: a save from an edited game may name a removed entity.
      ({ id: sourceId, name: "Someone", glyph: "?", x: 0, y: 0, blocking: true, interactions: [] } as Entity);
    while (frames.length > 0) {
      if (this.state.won) return;
      const top = frames[frames.length - 1];
      const cmd = top.shift();
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
        this.state.pendingChoice = {
          sourceId,
          prompt: cmd.prompt,
          options: open.map((o) => ({ label: o.label, commands: [...o.commands] })),
          continuations: frames
            .filter((f) => f.length > 0)
            .map((f) => [...f]),
        };
        events.push(cmd.prompt);
        open.forEach((o, i) => events.push(`${i + 1}) ${o.label}`));
        events.push(`Choose an option: choose1..choose${open.length}.`);
        return;
      }
      this.runCommand(source, cmd, events);
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
        events.push(`${source.name}: "${cmd.text}"`);
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
        this.state.won = true;
        events.push(cmd.text);
        events.push("*** YOU WIN ***");
        break;
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
