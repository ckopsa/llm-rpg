import {
  Sim,
  observe,
  parseAction,
  speciesById,
  type Ending,
  type Game,
} from "@llm-rpg/engine";
import {
  createBattleTracker,
  runExplorer,
  type BattleDetail,
  type BattleStats,
  type ExplorerOptions,
  type TranscriptEntry,
} from "./autoplay.js";

/**
 * Playtest-as-a-library: the run logic behind the `playtest` CLI, callable
 * in-process (e.g. by the MCP Forge server). `runScript` replays an action
 * list; `runExplore` runs the deterministic coverage explorer from
 * autoplay.ts. Both return plain, JSON-serializable report objects — no Sim
 * instances, no functions — so a report can go straight over a wire.
 */

/** One party member's final state, resolved to a species name. */
export interface PartySnapshot {
  speciesId: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
}

/** An action the sim refused (blocked move, mode mismatch, invalid choice). */
export interface Rejection {
  step: number;
  action: string;
  event: string;
}

/** Fields shared by script and explore reports. */
export interface BaseReport {
  game: { id: string; title: string; version: string };
  win: boolean;
  /** The ending reached, or null. `win` keeps its meaning: true iff
   *  ending.id === "victory". */
  ending: Ending | null;
  /** The run reached SOME ending (win included). For catalog-free narrative
   *  games — where every ending is a completed story — this is the go/no-go
   *  signal; for catalog games `win` stays the bar. */
  completed: boolean;
  /** Actions issued. */
  steps: number;
  /** Sim turns consumed (rejected mode-mismatch actions don't advance turns). */
  turns: number;
  stopReason: string;
  stopDetail: string;
  finalMap: string;
  finalX: number;
  finalY: number;
  inBattle: boolean;
  party: PartySnapshot[];
  money: number;
  flags: string[];
  mapsVisited: string[];
  /** Unique entity ids interacted with at least once. */
  entitiesInteracted: string[];
  battles: BattleStats;
  /** Per-battle diagnosis records (opponent, steps, result, party HP after),
   *  in the order the battles started. */
  battleDetails: BattleDetail[];
  rejections: Rejection[];
  /** Up to the last `tail` events (default 20), formatted
   *  "step N (action): event". */
  lastEvents: string[];
  /** The full observation text at the end of the run. */
  finalObservation: string;
}

export interface ScriptReport extends BaseReport {
  mode: "script";
  /** How many actions the script contained (steps <= totalActions). */
  totalActions: number;
  /** "won" | "ended" | "stopped" | "script-exhausted" */
  stopReason: string;
}

export interface ExploreReport extends BaseReport {
  mode: "explore";
  /** "won" | "ended" | "exhausted" | "max-steps" | "stalled" */
  stopReason: string;
  mapsUnvisited: string[];
  entitiesTotal: number;
  /** Distinct (entity, flag-state) interactions performed. */
  interactionCount: number;
}

export interface RunScriptOptions {
  /** Sim seed. Default 1 (same as the interactive CLI). */
  seed?: number;
  /** Stop at the first rejected action instead of recording and continuing. */
  strict?: boolean;
  /** How many trailing events `lastEvents` keeps. Default 20. */
  tail?: number;
  /** Called once per action with the transcript entry (for JSONL logs). */
  onStep?: (entry: TranscriptEntry) => void;
}

export interface RunExploreOptions extends ExplorerOptions {
  /** How many trailing events `lastEvents` keeps. Default 20. */
  tail?: number;
  /** Called once per action with the transcript entry (for JSONL logs). */
  onStep?: (entry: TranscriptEntry) => void;
}

/** Events that mean the action did not do what the script intended. */
const REJECTION_PATTERNS: RegExp[] = [
  /^You can't go /,
  /^You are in a battle — valid actions/,
  /^There is no battle right now/,
  /^The game is already won/,
  /^The battle is already over/,
  /^There is no move in slot/,
  /has no PP left — choose another move\.$/,
  /^There is no party member in slot/,
  /is already out\.$/,
  /has fainted and can't battle\.$/,
  /has fainted — you must switch/,
  /^There is no item in slot/,
  /^You aren't carrying any items\.$/,
  /^You have nothing to catch with/,
  /^You can't catch another keeper's kindred!$/,
  /^You can't run from a trainer battle!$/,
  /^There is nothing next to you to interact with\.$/,
  /is standing there\. Try "interact"\.$/,
  /^A choice is before you — pick an option/,
  /^There is no choice to make right now/,
  /^There is no option /,
  /^You shouldn't step into the tall grass/,
  /too weary for the tall grass/,
  /No kindred fit to battle/,
  /^The game has ended\./,
];

export function rejectionIn(events: string[]): string | undefined {
  return events.find((ev) => REJECTION_PATTERNS.some((p) => p.test(ev)));
}

/** Split a script source into action words: whitespace/comma separated,
 *  `#` comments to end of line. */
export function parseScriptWords(source: string): string[] {
  return source
    .replace(/#[^\n]*/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
}

function partySnapshot(sim: Sim): PartySnapshot[] {
  // A non-empty party implies a catalog (catalog-free games have neither).
  return sim.state.party.map((c) => ({
    speciesId: c.speciesId,
    name: speciesById(sim.game.catalog!, c.speciesId).name,
    level: c.level,
    hp: c.hp,
    maxHp: c.maxHp,
  }));
}

/** "Emberling Lv5 18/20 · ..." — the CLI's one-line party summary. */
export function partyLine(party: PartySnapshot[]): string {
  if (party.length === 0) return "(empty)";
  return party.map((p) => `${p.name} Lv${p.level} ${p.hp}/${p.maxHp}`).join(" · ");
}

function tailEvents(transcript: TranscriptEntry[], n: number): string[] {
  const flat: string[] = [];
  for (const t of transcript) {
    for (const ev of t.events) flat.push(`step ${t.step} (${t.action}): ${ev}`);
  }
  return flat.slice(-n);
}

function gameMeta(game: Game): BaseReport["game"] {
  return { id: game.meta.id, title: game.meta.title, version: game.meta.version };
}

/** The entity `interact` would target from (x, y): first at manhattan 1. */
function interactTarget(game: Game, mapId: string, x: number, y: number) {
  return game.maps[mapId].entities.find(
    (e) => Math.abs(e.x - x) + Math.abs(e.y - y) === 1,
  );
}

/**
 * Replay a script (an action-word list or raw script source) against a fresh
 * sim and report the outcome. Rejected actions are recorded; by default the
 * run continues (verified scripts legitimately contain harmless no-ops such
 * as wall bumps that fish for encounters) — `strict` stops at the first one.
 * An unknown action word always stops the run.
 */
export function runScript(
  game: Game,
  actions: string[] | string,
  opts: RunScriptOptions = {},
): ScriptReport {
  const words = Array.isArray(actions) ? actions : parseScriptWords(actions);
  const sim = new Sim(game, opts.seed ?? 1);
  const transcript: TranscriptEntry[] = [];
  const rejections: Rejection[] = [];
  const visitedMaps = new Set<string>([sim.state.map]);
  const interactedEntities = new Set<string>();
  const tracker = createBattleTracker(sim);
  let executed = 0;
  let stopped: string | undefined;

  for (const word of words) {
    const action = parseAction(word);
    if (!action) {
      stopped = `unknown action "${word}" at step ${executed + 1} — valid: north south east west interact choose1..9 lead1..6 | move1..4 switch1..6 item1..9 catch run`;
      break;
    }
    executed += 1;
    const wasInBattle = !!sim.state.battle;
    if (action.type === "interact" && !wasInBattle && !sim.state.won) {
      const target = interactTarget(game, sim.state.map, sim.state.playerX, sim.state.playerY);
      if (target) interactedEntities.add(target.id);
    }
    const events = sim.act(action);
    visitedMaps.add(sim.state.map);
    const entry: TranscriptEntry = {
      step: executed,
      action: word,
      events,
      map: sim.state.map,
      battle: !!sim.state.battle,
    };
    transcript.push(entry);
    opts.onStep?.(entry);

    tracker.record(executed, wasInBattle, events);

    const rejected = rejectionIn(events);
    if (rejected) {
      rejections.push({ step: executed, action: word, event: rejected });
      if (opts.strict) {
        stopped = `action "${word}" rejected at step ${executed}: ${rejected}`;
        break;
      }
    }
    if (sim.state.won || sim.state.ending) break;
  }

  const win = sim.state.won;
  const ending = sim.state.ending ?? null;
  return {
    mode: "script",
    game: gameMeta(game),
    win,
    ending,
    completed: win || ending !== null,
    steps: executed,
    totalActions: words.length,
    turns: sim.state.turn,
    stopReason: win ? "won" : ending ? "ended" : stopped ? "stopped" : "script-exhausted",
    stopDetail: win
      ? "reached the win condition"
      : ending
        ? `reached ending "${ending.id}"`
        : stopped ?? "script ran out before the win condition",
    finalMap: sim.state.map,
    finalX: sim.state.playerX,
    finalY: sim.state.playerY,
    inBattle: !!sim.state.battle,
    party: partySnapshot(sim),
    money: sim.state.money,
    flags: [...sim.state.flags],
    mapsVisited: Object.keys(game.maps).filter((id) => visitedMaps.has(id)),
    entitiesInteracted: [...interactedEntities],
    battles: tracker.stats,
    battleDetails: tracker.details,
    rejections,
    lastEvents: tailEvents(transcript, opts.tail ?? 20),
    finalObservation: observe(sim),
  };
}

/**
 * Run the deterministic coverage explorer (see autoplay.ts) and report what
 * it covered and where (and why) it stopped.
 */
export function runExplore(game: Game, opts: RunExploreOptions = {}): ExploreReport {
  const { sim, report, transcript } = runExplorer(game, {
    maxSteps: opts.maxSteps,
    seed: opts.seed,
  });
  if (opts.onStep) for (const entry of transcript) opts.onStep(entry);

  const rejections: Rejection[] = [];
  for (const t of transcript) {
    const rejected = rejectionIn(t.events);
    if (rejected) rejections.push({ step: t.step, action: t.action, event: rejected });
  }

  return {
    mode: "explore",
    game: gameMeta(game),
    win: report.won,
    ending: report.ending,
    completed: report.won || report.ending !== null,
    steps: report.steps,
    turns: report.turns,
    stopReason: report.stopReason,
    stopDetail: report.stopDetail,
    finalMap: report.finalMap,
    finalX: report.finalX,
    finalY: report.finalY,
    inBattle: !!sim.state.battle,
    party: partySnapshot(sim),
    money: report.money,
    flags: report.flags,
    mapsVisited: report.mapsVisited,
    mapsUnvisited: report.mapsUnvisited,
    entitiesInteracted: report.entitiesInteracted,
    entitiesTotal: report.entitiesTotal,
    interactionCount: report.interactionCount,
    battles: report.battles,
    battleDetails: report.battleDetails,
    rejections,
    lastEvents: tailEvents(transcript, opts.tail ?? 20),
    finalObservation: observe(sim),
  };
}
