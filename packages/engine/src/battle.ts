import type { Rng } from "./rng.js";
import type { Catalog, Move } from "./catalog.js";
import {
  moveById,
  movesKnownAtLevel,
  speciesById,
  statsAtLevel,
  typeMultiplier,
} from "./catalog.js";

/**
 * Deterministic turn-based battle. Pure module, no I/O: all randomness flows
 * through the injected Rng, so (catalog, parties, seed, action script) fully
 * determines the event log and end state.
 *
 * Formulas (documented once, here):
 *  - Damage: floor((floor((2*level/5 + 2) * power * atk / max(1, def)) / 50 + 2)
 *            * stab * typeMult * roll), where stab = 1.5 if the attacker has
 *    the move's type, typeMult multiplies across both defender types, and
 *    roll is uniform in [0.85, 1.0]. Minimum 1 damage when typeMult > 0.
 *  - Stat stages: each raise/lower effect shifts a stage by ±1, clamped
 *    to [-4, +4]. Multiplier = (2+s)/2 for s >= 0, 2/(2-s) for s < 0.
 *    Stages reset when a combatant leaves the field.
 *  - Turn order: higher effective spd first; ties broken by rng.chance(0.5).
 *  - Escape (wild only): chance = clamp(0.5 + 0.1 * (playerSpd - enemySpd)
 *    / max(1, enemySpd), 0.1, 0.95), using unmodified (stage-free) spd.
 *  - When every move's PP is 0, any "move" action becomes the built-in
 *    fallback Flail (normal, physical, power 20, never misses, costs no PP)
 *    so battles always terminate.
 *  - Catch (wild only): p = clamp(catchRate * ballMod * (1.3 - hp/maxHp),
 *    0.05, 0.95) via rng.chance. Failure consumes the turn (enemy attacks).
 *  - XP: when an enemy faints, the player's active combatant gains
 *    floor(xpYield * enemyLevel / 5). Total XP for level L is L^3. Level-ups
 *    recompute stats via statsAtLevel (healing by the HP-stat increase only)
 *    and learn learnset moves at the new level; with 4 moves known, the
 *    OLDEST move is replaced automatically.
 */

export interface CombatantMove {
  moveId: string;
  pp: number;
}

/** A concrete creature in a party: species instance + current battle stats. */
export interface Combatant {
  speciesId: string;
  level: number;
  /** Total experience. Level curve: total XP required for level L is L^3. */
  xp: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  moves: CombatantMove[];
}

/** Total XP at which level L is reached (cubic curve). */
export function xpForLevel(level: number): number {
  return level ** 3;
}

/** XP granted for fainting an enemy: floor(xpYield * enemyLevel / 5). */
export function xpYieldFor(xpYield: number, enemyLevel: number): number {
  return Math.floor((xpYield * enemyLevel) / 5);
}

/** Built-in fallback move, used when a combatant has no PP left anywhere. */
export const FLAIL: Move = {
  id: "__flail",
  name: "Flail",
  type: "normal",
  category: "physical",
  power: 20,
  accuracy: 1,
  pp: 1,
};

export function createCombatant(
  catalog: Catalog,
  speciesId: string,
  level: number,
): Combatant {
  const species = speciesById(catalog, speciesId);
  const stats = statsAtLevel(species, level);
  const moves = movesKnownAtLevel(species, level).map((moveId) => ({
    moveId,
    pp: moveById(catalog, moveId).pp,
  }));
  return {
    speciesId,
    level,
    xp: xpForLevel(level),
    hp: stats.hp,
    maxHp: stats.hp,
    atk: stats.atk,
    def: stats.def,
    spd: stats.spd,
    moves,
  };
}

export type BattleMode = "wild" | "trainer";
export type BattleOutcome =
  | "ongoing"
  | "player_won"
  | "enemy_won"
  | "fled"
  /** The active wild enemy was caught; it is `state.enemy.party[state.enemy.active]`. */
  | "captured";

export interface StatStages {
  atk: number;
  def: number;
  spd: number;
}

export interface SideState {
  party: Combatant[];
  active: number;
  stages: StatStages;
}

export interface BattleState {
  mode: BattleMode;
  player: SideState;
  enemy: SideState;
  outcome: BattleOutcome;
  round: number;
  /** True when the player's active creature fainted and a switch is required. */
  needsSwitch: boolean;
  /** Messages produced by the most recent action. */
  lastEvents: string[];
}

export type PlayerAction =
  | { type: "move"; index: number }
  | { type: "switch"; index: number }
  | { type: "run" }
  /** Use a heal item on the active creature. Consumes the turn (enemy attacks). */
  | { type: "item"; name: string; heal: number }
  /** Throw a capture item (wild battles only). The caller (Sim) owns the
   *  inventory and consumes the item; the battle only rolls the catch. */
  | { type: "catch"; name: string; ballMod: number };

/**
 * Enemy move chooser. Returns an index into the active enemy's moves array,
 * or -1 to use the Flail fallback. Swap it via BattleOptions.enemyAi.
 */
export type EnemyAi = (enemy: Combatant, catalog: Catalog, rng: Rng) => number;

export const randomEnemyAi: EnemyAi = (enemy, _catalog, rng) => {
  const usable = enemy.moves
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.pp > 0)
    .map(({ i }) => i);
  if (usable.length === 0) return -1;
  return usable[rng.int(0, usable.length - 1)];
};

export interface BattleOptions {
  mode: BattleMode;
  playerParty: Combatant[];
  enemyParty: Combatant[];
  rng: Rng;
  enemyAi?: EnemyAi;
  /** Resume a saved battle: adopt this state object directly (it becomes
   *  `battle.state`, aliasing intact) instead of building a fresh round-0
   *  state. The party arrays inside it take precedence over playerParty/
   *  enemyParty, so pass the same arrays for consistency. */
  state?: BattleState;
}

export function createBattle(catalog: Catalog, opts: BattleOptions): Battle {
  return new Battle(catalog, opts);
}

const freshStages = (): StatStages => ({ atk: 0, def: 0, spd: 0 });

function stageMultiplier(stage: number): number {
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

const STAT_LABEL: Record<keyof StatStages, string> = {
  atk: "Atk",
  def: "Def",
  spd: "Spd",
};

export class Battle {
  readonly catalog: Catalog;
  readonly state: BattleState;
  private rng: Rng;
  private enemyAi: EnemyAi;

  constructor(catalog: Catalog, opts: BattleOptions) {
    if (opts.playerParty.length === 0) {
      throw new Error("createBattle: playerParty must have at least one combatant");
    }
    if (opts.enemyParty.length === 0) {
      throw new Error("createBattle: enemyParty must have at least one combatant");
    }
    this.catalog = catalog;
    this.rng = opts.rng;
    this.enemyAi = opts.enemyAi ?? randomEnemyAi;
    this.state = opts.state ?? {
      mode: opts.mode,
      player: { party: opts.playerParty, active: 0, stages: freshStages() },
      enemy: { party: opts.enemyParty, active: 0, stages: freshStages() },
      outcome: "ongoing",
      round: 0,
      needsSwitch: false,
      lastEvents: [],
    };
  }

  private active(side: SideState): Combatant {
    return side.party[side.active];
  }

  private nameOf(c: Combatant, side: "player" | "enemy"): string {
    const species = speciesById(this.catalog, c.speciesId);
    return side === "enemy" ? `Enemy ${species.name}` : species.name;
  }

  private effectiveStat(side: SideState, stat: keyof StatStages): number {
    return Math.max(
      1,
      Math.floor(this.active(side)[stat] * stageMultiplier(side.stages[stat])),
    );
  }

  /** Advance one full round for a player action. Returns the event log. */
  act(action: PlayerAction): string[] {
    const events: string[] = [];
    const s = this.state;
    if (s.outcome !== "ongoing") {
      events.push("The battle is already over.");
      s.lastEvents = events;
      return events;
    }

    if (s.needsSwitch) {
      if (action.type !== "switch") {
        events.push(
          `${this.nameOf(this.active(s.player), "player")} has fainted — you must switch (e.g. switch2).`,
        );
        s.lastEvents = events;
        return events;
      }
      if (this.trySwitch(action.index, events)) {
        s.needsSwitch = false; // free switch after a faint: enemy does not attack
      }
      s.lastEvents = events;
      return events;
    }

    switch (action.type) {
      case "run":
        this.doRun(events);
        break;
      case "switch":
        if (this.trySwitch(action.index, events)) {
          s.round += 1;
          this.enemyAttack(events); // switching gives the enemy a free hit
          this.endOfRound(events);
        }
        break;
      case "move":
        this.doMoveRound(action.index, events);
        break;
      case "item":
        this.doItemRound(action.name, action.heal, events);
        break;
      case "catch":
        this.doCatch(action.name, action.ballMod, events);
        break;
    }
    s.lastEvents = events;
    return events;
  }

  /** Voluntary or forced switch. Returns false (with an event) if invalid. */
  private trySwitch(index: number, events: string[]): boolean {
    const side = this.state.player;
    const target = side.party[index];
    if (!target) {
      events.push(
        `There is no party member in slot ${index + 1} — valid: switch1..switch${side.party.length}.`,
      );
      return false;
    }
    if (index === side.active && this.active(side).hp > 0) {
      events.push(`${this.nameOf(target, "player")} is already out.`);
      return false;
    }
    if (target.hp <= 0) {
      events.push(
        `${this.nameOf(target, "player")} has fainted and can't battle.`,
      );
      return false;
    }
    const current = this.active(side);
    if (current.hp > 0) {
      events.push(`You withdrew ${this.nameOf(current, "player")}.`);
    }
    side.active = index;
    side.stages = freshStages();
    events.push(`Go, ${this.nameOf(target, "player")}!`);
    return true;
  }

  private doRun(events: string[]): void {
    const s = this.state;
    if (s.mode === "trainer") {
      events.push("You can't run from a trainer battle!");
      return; // round not consumed
    }
    const pSpd = this.active(s.player).spd;
    const eSpd = this.active(s.enemy).spd;
    const chance = Math.min(
      0.95,
      Math.max(0.1, 0.5 + (0.1 * (pSpd - eSpd)) / Math.max(1, eSpd)),
    );
    s.round += 1;
    if (this.rng.chance(chance)) {
      events.push("You got away safely!");
      s.outcome = "fled";
      return;
    }
    events.push("You couldn't escape!");
    this.enemyAttack(events);
    this.endOfRound(events);
  }

  /** Resolve the player's chosen move: index, PP check, or Flail fallback. */
  private resolvePlayerMove(
    index: number,
    events: string[],
  ): { move: Move; slot?: CombatantMove } | undefined {
    const me = this.active(this.state.player);
    const anyPp = me.moves.some((m) => m.pp > 0);
    if (!anyPp) {
      return { move: FLAIL }; // out of PP everywhere: any move action flails
    }
    const slot = me.moves[index];
    if (!slot) {
      events.push(
        `There is no move in slot ${index + 1} — valid: move1..move${me.moves.length}.`,
      );
      return undefined;
    }
    if (slot.pp <= 0) {
      const move = moveById(this.catalog, slot.moveId);
      events.push(`${move.name} has no PP left — choose another move.`);
      return undefined;
    }
    return { move: moveById(this.catalog, slot.moveId), slot };
  }

  private doMoveRound(index: number, events: string[]): void {
    const s = this.state;
    const chosen = this.resolvePlayerMove(index, events);
    if (!chosen) return; // invalid choice costs nothing

    s.round += 1;
    const pSpd = this.effectiveStat(s.player, "spd");
    const eSpd = this.effectiveStat(s.enemy, "spd");
    const playerFirst =
      pSpd > eSpd || (pSpd === eSpd && this.rng.chance(0.5));

    const playerTurn = () => {
      if (this.active(s.player).hp <= 0 || s.outcome !== "ongoing") return;
      if (chosen.slot) chosen.slot.pp -= 1;
      if (!chosen.slot) {
        events.push(
          `${this.nameOf(this.active(s.player), "player")} has no PP left for any move!`,
        );
      }
      this.executeMove(s.player, s.enemy, "player", chosen.move, events);
    };
    const enemyTurn = () => {
      if (this.active(s.enemy).hp <= 0 || s.outcome !== "ongoing") return;
      this.enemyAttack(events);
    };

    if (playerFirst) {
      playerTurn();
      enemyTurn();
    } else {
      enemyTurn();
      playerTurn();
    }
    this.endOfRound(events);
  }

  /** Use a heal item on the active creature. Costs the turn: enemy attacks. */
  private doItemRound(name: string, heal: number, events: string[]): void {
    const s = this.state;
    const me = this.active(s.player);
    s.round += 1;
    const before = me.hp;
    me.hp = Math.min(me.maxHp, me.hp + heal);
    events.push(
      `You used ${name}. ${this.nameOf(me, "player")} recovered ${me.hp - before} HP.`,
    );
    this.enemyAttack(events);
    this.endOfRound(events);
  }

  /**
   * Throw a capture item at the active wild enemy.
   * p = clamp(catchRate * ballMod * (1.3 - hp/maxHp), 0.05, 0.95).
   * Failure consumes the enemy's turn normally.
   */
  private doCatch(name: string, ballMod: number, events: string[]): void {
    const s = this.state;
    if (s.mode === "trainer") {
      events.push("You can't catch another keeper's kindred!");
      return; // round not consumed
    }
    const enemy = this.active(s.enemy);
    const species = speciesById(this.catalog, enemy.speciesId);
    const p = Math.min(
      0.95,
      Math.max(0.05, species.catchRate * ballMod * (1.3 - enemy.hp / enemy.maxHp)),
    );
    s.round += 1;
    events.push(`You threw a ${name}!`);
    if (this.rng.chance(p)) {
      s.outcome = "captured";
      events.push(`Gotcha! The wild ${species.name} was caught!`);
      return;
    }
    events.push(`The wild ${species.name} broke free!`);
    this.enemyAttack(events);
    this.endOfRound(events);
  }

  private enemyAttack(events: string[]): void {
    const s = this.state;
    if (s.outcome !== "ongoing") return;
    const enemy = this.active(s.enemy);
    if (enemy.hp <= 0) return;
    const choice = this.enemyAi(enemy, this.catalog, this.rng);
    let move: Move;
    if (choice < 0) {
      events.push(`${this.nameOf(enemy, "enemy")} has no PP left for any move!`);
      move = FLAIL;
    } else {
      const slot = enemy.moves[choice];
      if (!slot || slot.pp <= 0) {
        throw new Error(
          `enemyAi returned index ${choice}, which is not a usable move (needs pp > 0)`,
        );
      }
      slot.pp -= 1;
      move = moveById(this.catalog, slot.moveId);
    }
    this.executeMove(s.enemy, s.player, "enemy", move, events);
  }

  private executeMove(
    attackerSide: SideState,
    defenderSide: SideState,
    attackerLabel: "player" | "enemy",
    move: Move,
    events: string[],
  ): void {
    const defenderLabel = attackerLabel === "player" ? "enemy" : "player";
    const attacker = this.active(attackerSide);
    const defender = this.active(defenderSide);
    const attackerName = this.nameOf(attacker, attackerLabel);
    const defenderName = this.nameOf(defender, defenderLabel);

    events.push(`${attackerName} used ${move.name}!`);
    if (!this.rng.chance(move.accuracy)) {
      events.push(`${attackerName}'s ${move.name} missed!`);
      return;
    }

    if (move.category === "status" || move.power === 0) {
      this.applyEffect(attackerSide, defenderSide, attackerLabel, move, events);
      return;
    }

    const attackerSpecies = speciesById(this.catalog, attacker.speciesId);
    const defenderSpecies = speciesById(this.catalog, defender.speciesId);
    const mult = typeMultiplier(
      this.catalog.typeChart,
      move.type,
      defenderSpecies.types,
    );
    if (mult === 0) {
      events.push(`It doesn't affect ${defenderName}...`);
      return;
    }
    const stab = attackerSpecies.types.includes(move.type) ? 1.5 : 1;
    const atk = this.effectiveStat(attackerSide, "atk");
    const def = this.effectiveStat(defenderSide, "def");
    const roll = 0.85 + this.rng.next() * 0.15;
    const base = Math.floor(
      ((2 * attacker.level) / 5 + 2) * move.power * (atk / Math.max(1, def)),
    );
    const damage = Math.max(
      1,
      Math.floor((base / 50 + 2) * stab * mult * roll),
    );

    if (mult > 1) events.push("It's super effective!");
    if (mult < 1) events.push("It's not very effective...");
    defender.hp = Math.max(0, defender.hp - damage);
    events.push(`${defenderName} took ${damage} damage.`);
    if (defender.hp <= 0) {
      events.push(`${defenderName} fainted!`);
    }
    this.applyEffect(attackerSide, defenderSide, attackerLabel, move, events);
  }

  private applyEffect(
    attackerSide: SideState,
    defenderSide: SideState,
    attackerLabel: "player" | "enemy",
    move: Move,
    events: string[],
  ): void {
    if (!move.effect) {
      if (move.category === "status") events.push("But nothing happened!");
      return;
    }
    const [dir, stat] = move.effect.kind.split("_") as [
      "raise" | "lower",
      keyof StatStages,
    ];
    const raising = dir === "raise";
    const side = raising ? attackerSide : defenderSide;
    const label = raising ? attackerLabel : attackerLabel === "player" ? "enemy" : "player";
    const target = this.active(side);
    if (target.hp <= 0) return;
    const name = this.nameOf(target, label);
    const delta = raising ? 1 : -1;
    const current = side.stages[stat];
    const next = Math.max(-4, Math.min(4, current + delta));
    if (next === current) {
      events.push(
        `${name}'s ${STAT_LABEL[stat]} won't go any ${raising ? "higher" : "lower"}!`,
      );
      return;
    }
    side.stages[stat] = next;
    events.push(`${name}'s ${STAT_LABEL[stat]} ${raising ? "rose" : "fell"}!`);
  }

  /** Award XP for a fainted enemy to the player's active combatant, leveling up. */
  private grantXp(fainted: Combatant, events: string[]): void {
    const me = this.active(this.state.player);
    const species = speciesById(this.catalog, fainted.speciesId);
    const gain = xpYieldFor(species.xpYield, fainted.level);
    if (gain <= 0) return;
    me.xp += gain;
    events.push(`${this.nameOf(me, "player")} gained ${gain} XP.`);
    while (me.xp >= xpForLevel(me.level + 1)) {
      this.levelUp(me, events);
    }
  }

  /** One level: recompute stats (heal by the HP increase only), learn moves. */
  private levelUp(c: Combatant, events: string[]): void {
    c.level += 1;
    const species = speciesById(this.catalog, c.speciesId);
    const stats = statsAtLevel(species, c.level);
    const hpGain = stats.hp - c.maxHp;
    c.maxHp = stats.hp;
    c.hp = Math.min(c.maxHp, c.hp + Math.max(0, hpGain));
    c.atk = stats.atk;
    c.def = stats.def;
    c.spd = stats.spd;
    const name = this.nameOf(c, "player");
    events.push(`${name} grew to Lv ${c.level}!`);
    for (const entry of species.learnset) {
      if (entry.level !== c.level) continue;
      if (c.moves.some((m) => m.moveId === entry.moveId)) continue;
      const move = moveById(this.catalog, entry.moveId);
      if (c.moves.length < 4) {
        c.moves.push({ moveId: entry.moveId, pp: move.pp });
        events.push(`${name} learned ${move.name}!`);
      } else {
        // Four moves known: the oldest (first-learned) slot makes way.
        const forgotten = c.moves.shift()!;
        c.moves.push({ moveId: entry.moveId, pp: move.pp });
        events.push(
          `${name} forgot ${moveById(this.catalog, forgotten.moveId).name} and learned ${move.name}!`,
        );
      }
    }
  }

  /** Handle faints: enemy auto-replacement, player switch prompt, outcomes. */
  private endOfRound(events: string[]): void {
    const s = this.state;
    if (s.outcome !== "ongoing") return;

    if (this.active(s.enemy).hp <= 0) {
      this.grantXp(this.active(s.enemy), events);
      const next = s.enemy.party.findIndex((c) => c.hp > 0);
      if (next === -1) {
        s.outcome = "player_won";
        events.push("You won the battle!");
        return;
      }
      s.enemy.active = next;
      s.enemy.stages = freshStages();
      events.push(`${this.nameOf(this.active(s.enemy), "enemy")} was sent out!`);
    }

    if (this.active(s.player).hp <= 0) {
      const anyLeft = s.player.party.some((c) => c.hp > 0);
      if (!anyLeft) {
        s.outcome = "enemy_won";
        events.push("You have no creatures left. You lost the battle!");
        return;
      }
      s.needsSwitch = true;
      events.push("Choose your next creature (switch1..switch6).");
    }
  }
}
