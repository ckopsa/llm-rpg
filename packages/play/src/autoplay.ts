import {
  Sim,
  moveById,
  type Action,
  type Direction,
  type Entity,
  type Game,
  type MapDef,
} from "@llm-rpg/engine";

/**
 * Goal-mode autoplayer for the playtest harness: a deterministic explorer
 * whose job is coverage smoke-testing, not winning. It BFS-pathfinds over
 * walkable tiles (across portals) to
 *   (a) interact with every reachable entity once per flag-state,
 *   (b) step into every reachable map,
 *   (c) fight battles greedily (highest-power usable move, switch on faint,
 *       catch nothing), and
 *   (d) run from wild battles when the party is close to wiping.
 * All randomness is the sim's seeded Rng; every tie-break here is stable
 * ordering (map/entity definition order, fixed direction order) — no
 * Math.random — so a run is exactly reproducible.
 */

export interface TranscriptEntry {
  step: number;
  action: string;
  events: string[];
  /** Map the player is on after the action. */
  map: string;
  /** Whether a battle is active after the action. */
  battle: boolean;
  /** Explorer only: what the step was working toward. */
  target?: string;
}

export interface BattleStats {
  fought: number;
  won: number;
  lost: number;
  fled: number;
}

export interface ExplorerReport {
  won: boolean;
  steps: number;
  turns: number;
  /** "won" | "exhausted" | "max-steps" | "stalled" */
  stopReason: string;
  stopDetail: string;
  mapsVisited: string[];
  mapsUnvisited: string[];
  /** Unique entity ids interacted with at least once. */
  entitiesInteracted: string[];
  entitiesTotal: number;
  /** Distinct (entity, flag-state) interactions performed. */
  interactionCount: number;
  flags: string[];
  battles: BattleStats;
  finalMap: string;
  finalX: number;
  finalY: number;
  money: number;
}

export interface ExplorerOptions {
  /** Step budget (actions issued). Default 1000. */
  maxSteps?: number;
  /** Sim seed. Default 1 (same as the interactive CLI). */
  seed?: number;
}

export interface ExplorerResult {
  sim: Sim;
  report: ExplorerReport;
  transcript: TranscriptEntry[];
}

const DIR_LIST: readonly [Direction, number, number][] = [
  ["north", 0, -1],
  ["south", 0, 1],
  ["east", 1, 0],
  ["west", -1, 0],
];

/** Stop re-challenging (and start avoiding the sight-line of) a trainer after
 *  losing to them this many times — the explorer does not grind. */
const TRAINER_LOSS_CAP = 2;

/** Consecutive planned moves that change nothing before the run aborts. */
const STALL_LIMIT = 25;

/** Identical presentations of the same choice before the explorer moves on
 *  to the next option (first-option policy with a loop escape). */
const CHOICE_REPEAT_LIMIT = 3;

/** Compact string form of an Action (inverse of parseAction). */
export function actionWord(a: Action): string {
  switch (a.type) {
    case "move":
      return a.dir;
    case "interact":
      return "interact";
    case "choose":
      return `choose${a.index + 1}`;
    case "battle_move":
      return `move${a.index + 1}`;
    case "battle_switch":
      return `switch${a.index + 1}`;
    case "battle_item":
      return `item${a.index + 1}`;
    case "battle_catch":
      return "catch";
    case "battle_run":
      return "run";
  }
}

/**
 * Greedy battle policy: forced switch goes to the first healthy party member;
 * a wild battle is fled when the party is under a quarter of its total HP;
 * otherwise use the highest-power move with PP (first slot on ties; move1
 * when nothing has PP — the engine substitutes Flail).
 */
export function chooseBattleAction(sim: Sim): Action {
  // Only called while a battle is active — which requires a catalog; a
  // catalog-free narrative game never reaches this policy.
  const b = sim.state.battle!;
  if (b.needsSwitch) {
    const idx = b.player.party.findIndex((c) => c.hp > 0);
    return { type: "battle_switch", index: Math.max(0, idx) };
  }
  if (b.mode === "wild") {
    const hp = b.player.party.reduce((sum, c) => sum + c.hp, 0);
    const maxHp = b.player.party.reduce((sum, c) => sum + c.maxHp, 0);
    if (maxHp > 0 && hp / maxHp < 0.25) return { type: "battle_run" };
  }
  const me = b.player.party[b.player.active];
  let best = -1;
  let bestPower = -1;
  me.moves.forEach((slot, i) => {
    if (slot.pp <= 0) return;
    const power = moveById(sim.game.catalog!, slot.moveId).power;
    if (power > bestPower) {
      bestPower = power;
      best = i;
    }
  });
  return { type: "battle_move", index: best === -1 ? 0 : best };
}

interface Plan {
  action: Action;
  target: string;
}

export function runExplorer(game: Game, opts: ExplorerOptions = {}): ExplorerResult {
  const maxSteps = opts.maxSteps ?? 1000;
  const sim = new Sim(game, opts.seed ?? 1);
  const transcript: TranscriptEntry[] = [];

  const visitedMaps = new Set<string>([sim.state.map]);
  const interacted = new Set<string>(); // `${entityId}|${flagsKey}`
  const interactedEntities = new Set<string>();
  const trainerLosses = new Map<string, number>();
  const choiceSeen = new Map<string, number>(); // identical-presentation counts
  const battles: BattleStats = { fought: 0, won: 0, lost: 0, fled: 0 };

  // Pre-split rows once (mirrors the sim's grids, which are private).
  const grids = new Map<string, string[][]>();
  for (const [id, def] of Object.entries(game.maps)) {
    grids.set(id, def.rows.map((r) => [...r]));
  }

  const flagsKey = () => [...sim.state.flags].sort().join(",");

  const grassBlocked = () =>
    sim.state.party.length === 0 || sim.state.party.every((c) => c.hp <= 0);

  const blocksEntity = (e: Entity): boolean =>
    e.blocking && !(e.passableWithFlag && sim.state.flags.includes(e.passableWithFlag));

  /** The entity `interact` would target from (x, y): first at manhattan 1. */
  const firstAdjacent = (def: MapDef, x: number, y: number): Entity | undefined =>
    def.entities.find((e) => Math.abs(e.x - x) + Math.abs(e.y - y) === 1);

  const isPending = (e: Entity): boolean => {
    if (interacted.has(`${e.id}|${flagsKey()}`)) return false;
    if (
      e.trainer &&
      !sim.state.flags.includes(e.trainer.defeatFlag) &&
      (trainerLosses.get(e.id) ?? 0) >= TRAINER_LOSS_CAP
    ) {
      return false;
    }
    return true;
  };

  /** Sight-line tiles of undefeated trainers we keep losing to — avoided. */
  const dangerTiles = (): Set<string> => {
    const out = new Set<string>();
    for (const [mapId, def] of Object.entries(game.maps)) {
      for (const e of def.entities) {
        const t = e.trainer;
        if (!t?.lineOfSight) continue;
        if (sim.state.flags.includes(t.defeatFlag)) continue;
        if ((trainerLosses.get(e.id) ?? 0) < TRAINER_LOSS_CAP) continue;
        const entry = DIR_LIST.find(([d]) => d === t.lineOfSight!.dir)!;
        for (let k = 1; k <= t.lineOfSight.range; k++) {
          out.add(`${mapId}:${e.x + entry[1] * k}:${e.y + entry[2] * k}`);
        }
      }
    }
    return out;
  };

  /**
   * Pick the next overworld action. Interact if a pending entity is the
   * interact target right here; otherwise BFS (across portals) to the nearest
   * goal, preferring undiscovered maps over pending interactions so coverage
   * of the world graph comes first. Returns null when nothing is left.
   */
  const plan = (): Plan | null => {
    const state = sim.state;
    const here = firstAdjacent(game.maps[state.map], state.playerX, state.playerY);
    if (here && isPending(here)) {
      return {
        action: { type: "interact" },
        target: `interact: ${here.name} (${here.id}) on ${state.map}`,
      };
    }

    const avoid = dangerTiles();
    const noGrass = grassBlocked();
    interface Node {
      map: string;
      x: number;
      y: number;
      firstDir: Direction | null;
    }
    const startKey = `${state.map}:${state.playerX}:${state.playerY}`;
    const seen = new Set([startKey]);
    const queue: Node[] = [
      { map: state.map, x: state.playerX, y: state.playerY, firstDir: null },
    ];
    let head = 0;
    let interactionGoal: Plan | null = null;
    while (head < queue.length) {
      const cur = queue[head++];
      const def = game.maps[cur.map];
      const rows = grids.get(cur.map)!;
      for (const [dir, dx, dy] of DIR_LIST) {
        let nm = cur.map;
        let nx = cur.x + dx;
        let ny = cur.y + dy;
        if (ny < 0 || ny >= rows.length || nx < 0 || nx >= rows[0].length) continue;
        const tile = game.legend[rows[ny][nx]];
        if (!tile.walkable) continue;
        if (noGrass && tile.wild) continue;
        const ent = def.entities.find((e) => e.x === nx && e.y === ny);
        if (ent && blocksEntity(ent)) continue;
        const portal = def.portals.find((p) => p.x === nx && p.y === ny);
        if (portal) {
          nm = portal.toMap;
          nx = portal.toX;
          ny = portal.toY;
        }
        const key = `${nm}:${nx}:${ny}`;
        if (seen.has(key) || avoid.has(key)) continue;
        seen.add(key);
        const firstDir = cur.firstDir ?? dir;
        if (!visitedMaps.has(nm)) {
          // Map discovery outranks interactions: return immediately.
          return {
            action: { type: "move", dir: firstDir },
            target: `reach new map: ${nm}`,
          };
        }
        if (!interactionGoal) {
          const adj = firstAdjacent(game.maps[nm], nx, ny);
          if (adj && isPending(adj)) {
            interactionGoal = {
              action: { type: "move", dir: firstDir },
              target: `interact: ${adj.name} (${adj.id}) on ${nm}`,
            };
          }
        }
        queue.push({ map: nm, x: nx, y: ny, firstDir });
      }
    }
    return interactionGoal;
  };

  let steps = 0;
  let stopReason = "max-steps";
  let stopDetail = `step budget of ${maxSteps} exhausted`;
  let lastTarget = "";
  let stalls = 0;

  while (steps < maxSteps) {
    if (sim.state.won) break;

    let action: Action;
    let target: string | undefined;
    if (sim.state.pendingChoice) {
      // First-option policy, with a loop escape: an identical presentation
      // (same prompt/options/flags/vars) seen CHOICE_REPEAT_LIMIT times moves
      // on to the next option; a fully exhausted choice aborts as stalled.
      const pc = sim.state.pendingChoice;
      const varsKey = JSON.stringify(
        Object.entries(sim.state.vars).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      const key = `${pc.sourceId}|${pc.prompt}|${pc.options.map((o) => o.label).join("|")}|${flagsKey()}|${varsKey}`;
      const seen = choiceSeen.get(key) ?? 0;
      choiceSeen.set(key, seen + 1);
      const index = Math.floor(seen / CHOICE_REPEAT_LIMIT);
      if (index >= pc.options.length) {
        stopReason = "stalled";
        stopDetail = `the choice "${pc.prompt}" re-presented identically ${seen} times — every option tried ${CHOICE_REPEAT_LIMIT} times without changing state`;
        break;
      }
      action = { type: "choose", index };
      target = `choice: ${pc.prompt} -> option ${index + 1} (${pc.options[index].label})`;
    } else if (sim.state.battle) {
      action = chooseBattleAction(sim);
      target = lastTarget || undefined;
    } else {
      const next = plan();
      if (!next) {
        stopReason = "exhausted";
        stopDetail =
          "no reachable pending targets left (every reachable entity interacted with in the current flag-state, no undiscovered reachable maps)";
        break;
      }
      action = next.action;
      target = next.target;
      lastTarget = next.target;
    }

    const before = {
      map: sim.state.map,
      x: sim.state.playerX,
      y: sim.state.playerY,
      flags: flagsKey(),
      inBattle: !!sim.state.battle,
      trainer: sim.state.battleTrainer,
    };
    if (action.type === "interact") {
      const e = firstAdjacent(game.maps[before.map], before.x, before.y);
      if (e) {
        interacted.add(`${e.id}|${before.flags}`);
        interactedEntities.add(e.id);
      }
    }

    steps += 1;
    const events = sim.act(action);
    visitedMaps.add(sim.state.map);
    transcript.push({
      step: steps,
      action: actionWord(action),
      events,
      map: sim.state.map,
      battle: !!sim.state.battle,
      target,
    });

    if (!before.inBattle && sim.state.battle) battles.fought += 1;
    if (before.inBattle && !sim.state.battle) {
      if (events.includes("You won the battle!")) battles.won += 1;
      else if (events.includes("You got away safely!")) battles.fled += 1;
      else if (events.some((ev) => ev.includes("You lost the battle!"))) {
        battles.lost += 1;
        if (before.trainer) {
          trainerLosses.set(before.trainer, (trainerLosses.get(before.trainer) ?? 0) + 1);
        }
      }
    }

    // Stall guard: a planned move that changed nothing, repeatedly, means the
    // planner's model disagrees with the sim — abort with a diagnosis instead
    // of burning the budget.
    const moved =
      sim.state.map !== before.map ||
      sim.state.playerX !== before.x ||
      sim.state.playerY !== before.y;
    if (action.type === "move" && !moved && !sim.state.battle && flagsKey() === before.flags) {
      stalls += 1;
      if (stalls >= STALL_LIMIT) {
        stopReason = "stalled";
        stopDetail = `no progress for ${STALL_LIMIT} consecutive moves while pursuing "${target}" — last events: ${events.join(" | ")}`;
        break;
      }
    } else {
      stalls = 0;
    }
  }

  if (sim.state.won) {
    stopReason = "won";
    stopDetail = "reached the win condition";
  }

  const allMaps = Object.keys(game.maps);
  const entitiesTotal = allMaps.reduce(
    (sum, id) => sum + game.maps[id].entities.length,
    0,
  );
  const report: ExplorerReport = {
    won: sim.state.won,
    steps,
    turns: sim.state.turn,
    stopReason,
    stopDetail,
    mapsVisited: allMaps.filter((id) => visitedMaps.has(id)),
    mapsUnvisited: allMaps.filter((id) => !visitedMaps.has(id)),
    entitiesInteracted: [...interactedEntities],
    entitiesTotal,
    interactionCount: interacted.size,
    flags: [...sim.state.flags],
    battles,
    finalMap: sim.state.map,
    finalX: sim.state.playerX,
    finalY: sim.state.playerY,
    money: sim.state.money,
  };
  return { sim, report, transcript };
}
