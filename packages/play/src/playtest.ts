import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Sim, observe, parseAction, speciesById } from "@llm-rpg/engine";
import { loadGame, resolveGamePath, resolveUserPath } from "./load.js";
import {
  runExplorer,
  type TranscriptEntry,
  type ExplorerReport,
} from "./autoplay.js";

/**
 * Autoplay playtest harness — the build-side QA loop. Plays a game without a
 * human and reports either "completed" with stats or "stuck here" with a
 * diagnosis. Two modes:
 *
 *  Script mode (replay a known action list):
 *    npm run playtest -- --game <path> --script <file>
 *    npm run playtest -- --game <path> --actions "n n e interact"
 *  Actions are whitespace/comma-separated; `#` starts a comment (to line end)
 *  in script files. Rejected actions (blocked moves, mode mismatches, invalid
 *  battle choices) are recorded and reported; by default the run continues —
 *  verified scripts legitimately contain harmless no-ops (e.g. wall bumps to
 *  fish for encounters). Pass --strict to stop at the first rejection instead.
 *
 *  Goal mode (no script needed):
 *    npm run playtest -- --game <path> --goal explore --max-steps 1500
 *  Runs the deterministic explorer in autoplay.ts and reports coverage:
 *  maps visited, entities interacted, flags set, battles fought, and where
 *  (and why) it stopped. This is what you run first on new content to find
 *  unreachable maps and broken gates.
 *
 *  --transcript <file> (both modes) writes one JSON object per action:
 *  {step, action, events, map, battle}.  Exit code 0 only on a win.
 */

interface Args {
  game?: string;
  script?: string;
  actions?: string;
  goal?: string;
  maxSteps: number;
  seed: number;
  transcript?: string;
  strict: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { maxSteps: 1000, seed: 1, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--game") args.game = argv[++i];
    else if (a === "--script") args.script = argv[++i];
    else if (a === "--actions") args.actions = argv[++i];
    else if (a === "--goal") args.goal = argv[++i];
    else if (a === "--max-steps") args.maxSteps = Number(argv[++i]);
    else if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a === "--transcript") args.transcript = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (!a.startsWith("--")) args.game = a;
    else fail(`Unknown option "${a}". ${USAGE}`);
  }
  return args;
}

const USAGE = `Usage:
  playtest --game <game.json> --script <file>          replay a script file
  playtest --game <game.json> --actions "n n interact" replay inline actions
  playtest --game <game.json> --goal explore           built-in coverage autoplayer
Options: --max-steps N (default 1000) --seed N (default 1) --transcript <file.jsonl> --strict`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
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
  /^You shouldn't step into the tall grass/,
  /too weary for the tall grass/,
  /No kindred fit to battle/,
];

function rejectionIn(events: string[]): string | undefined {
  return events.find((ev) => REJECTION_PATTERNS.some((p) => p.test(ev)));
}

function partyLine(sim: Sim): string {
  if (sim.state.party.length === 0) return "(empty)";
  return sim.state.party
    .map((c) => {
      const s = speciesById(sim.game.catalog, c.speciesId);
      return `${s.name} Lv${c.level} ${c.hp}/${c.maxHp}`;
    })
    .join(" · ");
}

function writeTranscript(path: string, entries: TranscriptEntry[]): void {
  const resolved = resolveUserPath(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`Transcript: ${entries.length} entries written to ${resolved}`);
}

function tailEvents(transcript: TranscriptEntry[], n: number): string[] {
  const flat: string[] = [];
  for (const t of transcript) {
    for (const ev of t.events) flat.push(`step ${t.step} (${t.action}): ${ev}`);
  }
  return flat.slice(-n);
}

function printFailureDetail(sim: Sim, transcript: TranscriptEntry[]): void {
  console.log("\nLast 20 events:");
  for (const line of tailEvents(transcript, 20)) console.log(`  ${line}`);
  console.log("\nFinal observation:");
  console.log(observe(sim));
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const gamePath = resolveGamePath(args.game);
const game = loadGame(gamePath);
const modes = [args.script, args.actions, args.goal].filter((x) => x !== undefined);
if (modes.length !== 1) {
  fail(`Pick exactly one of --script, --actions, --goal. ${USAGE}`);
}
if (!Number.isInteger(args.maxSteps) || args.maxSteps < 1) {
  fail("--max-steps must be a positive integer.");
}
if (!Number.isFinite(args.seed)) fail("--seed must be a number.");

console.log("== PLAYTEST REPORT ==");
console.log(`Game: ${game.meta.title} (${game.meta.id} v${game.meta.version}) — ${gamePath}`);

let won: boolean;

if (args.goal !== undefined) {
  if (args.goal !== "explore") {
    fail(`Unknown goal "${args.goal}" — the only goal is "explore".`);
  }
  console.log(`Mode: goal=explore (seed ${args.seed}, max-steps ${args.maxSteps})`);
  const { sim, report, transcript } = runExplorer(game, {
    maxSteps: args.maxSteps,
    seed: args.seed,
  });
  printExplorerReport(sim, report);
  if (!report.won) printFailureDetail(sim, transcript);
  if (args.transcript) writeTranscript(args.transcript, transcript);
  won = report.won;
} else {
  const source =
    args.script !== undefined
      ? readFileSync(resolveUserPath(args.script), "utf8")
      : args.actions!;
  const words = source
    .replace(/#[^\n]*/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (words.length === 0) fail("The script contains no actions.");
  console.log(
    `Mode: script (${words.length} actions from ${
      args.script ? resolveUserPath(args.script) : "--actions"
    }, seed ${args.seed}${args.strict ? ", strict" : ""})`,
  );
  won = runScript(words);
}

process.exit(won ? 0 : 1);

// ---------------------------------------------------------------------------

function runScript(words: string[]): boolean {
  const sim = new Sim(game, args.seed);
  const transcript: TranscriptEntry[] = [];
  const rejections: { step: number; word: string; event: string }[] = [];
  let executed = 0;
  let stopped: string | undefined;

  for (const word of words) {
    const action = parseAction(word);
    if (!action) {
      stopped = `unknown action "${word}" at step ${executed + 1} — valid: north south east west interact | move1..4 switch1..6 item1..9 catch run`;
      break;
    }
    executed += 1;
    const events = sim.act(action);
    transcript.push({
      step: executed,
      action: word,
      events,
      map: sim.state.map,
      battle: !!sim.state.battle,
    });
    const rejected = rejectionIn(events);
    if (rejected) {
      rejections.push({ step: executed, word, event: rejected });
      if (args.strict) {
        stopped = `action "${word}" rejected at step ${executed}: ${rejected}`;
        break;
      }
    }
    if (sim.state.won) break;
  }

  const winner = sim.state.won;
  const result = winner
    ? "WIN"
    : stopped
      ? `STOPPED — ${stopped}`
      : "NOT WON — script ran out before the win condition";
  console.log(`Result: ${result}`);
  console.log(`Steps executed: ${executed} of ${words.length}`);
  console.log(`Turns: ${sim.state.turn}`);
  console.log(
    `Final: map=${sim.state.map}, pos=(${sim.state.playerX}, ${sim.state.playerY}), money=${sim.state.money}${sim.state.battle ? ", in battle" : ""}`,
  );
  console.log(`Party: ${partyLine(sim)}`);
  console.log(`Flags: ${sim.state.flags.join(", ") || "(none)"}`);
  if (rejections.length > 0) {
    console.log(`Rejected steps: ${rejections.length} (harmless no-ops unless the run failed)`);
    for (const r of rejections.slice(0, 10)) {
      console.log(`  step ${r.step} (${r.word}): ${r.event}`);
    }
    if (rejections.length > 10) console.log(`  ... and ${rejections.length - 10} more`);
  }
  if (!winner) printFailureDetail(sim, transcript);
  if (args.transcript) writeTranscript(args.transcript, transcript);
  return winner;
}

function printExplorerReport(sim: Sim, r: ExplorerReport): void {
  console.log(`Result: ${r.won ? "WIN" : `INCOMPLETE — ${r.stopReason}: ${r.stopDetail}`}`);
  console.log(`Steps: ${r.steps} (turns: ${r.turns})`);
  console.log(
    `Maps visited (${r.mapsVisited.length}/${r.mapsVisited.length + r.mapsUnvisited.length}): ${r.mapsVisited.join(", ")}`,
  );
  if (r.mapsUnvisited.length > 0) {
    console.log(`Maps NOT reached: ${r.mapsUnvisited.join(", ")}`);
  }
  console.log(
    `Entities interacted: ${r.entitiesInteracted.length}/${r.entitiesTotal} unique (${r.interactionCount} interactions across flag-states)`,
  );
  console.log(`Flags set (${r.flags.length}): ${r.flags.join(", ") || "(none)"}`);
  console.log(
    `Battles: ${r.battles.fought} fought — ${r.battles.won} won, ${r.battles.lost} lost, ${r.battles.fled} fled`,
  );
  console.log(
    `Final: map=${r.finalMap}, pos=(${r.finalX}, ${r.finalY}), money=${r.money}`,
  );
  console.log(`Party: ${partyLine(sim)}`);
}
