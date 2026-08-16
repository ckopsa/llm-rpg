import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadGame, resolveGamePath, resolveUserPath } from "./load.js";
import { type TranscriptEntry } from "./autoplay.js";
import {
  parseScriptWords,
  partyLine,
  runExplore,
  runScript,
  type ExploreReport,
  type ScriptReport,
} from "./run.js";
import { analyzeReachability, type ReachabilityReport } from "./reachability.js";

/**
 * Autoplay playtest harness — the build-side QA loop. Plays a game without a
 * human and reports either "completed" with stats or "stuck here" with a
 * diagnosis. This file is a thin CLI over the library in run.ts and
 * reachability.ts (the MCP Forge server calls those directly). Three modes:
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
 *  Reachability mode (instant, no simulation):
 *    npm run playtest -- --game <path> --goal reach
 *  Static BFS from the player start through walkable tiles and portals, in
 *  two passes: OPTIMISTIC (flag-gated blockers treated as open) and
 *  PESSIMISTIC (they never open). Reports per-map reachability under both,
 *  unreachable entities, orphan portals, and dead wild zones — in
 *  milliseconds, for tight authoring loops. Exit code 0 only on a pass.
 *
 *  --json (any mode) prints the report as JSON — the ONLY thing written to
 *  stdout; the human-readable report goes to stderr instead.
 *  --transcript <file> (script/explore) writes one JSON object per action:
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
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { maxSteps: 1000, seed: 1, strict: false, json: false };
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
    else if (a === "--json") args.json = true;
    else if (!a.startsWith("--")) args.game = a;
    else fail(`Unknown option "${a}". ${USAGE}`);
  }
  return args;
}

const USAGE = `Usage:
  playtest --game <game.json> --script <file>          replay a script file
  playtest --game <game.json> --actions "n n interact" replay inline actions
  playtest --game <game.json> --goal explore           built-in coverage autoplayer
  playtest --game <game.json> --goal reach             static reachability analysis
Options: --max-steps N (default 1000) --seed N (default 1) --transcript <file.jsonl> --strict --json`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
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

/** Human-readable lines: stdout normally, stderr in --json mode (stdout is
 *  reserved for the report object there). */
const out = args.json
  ? (line = "") => console.error(line)
  : (line = "") => console.log(line);

out("== PLAYTEST REPORT ==");
out(`Game: ${game.meta.title} (${game.meta.id} v${game.meta.version}) — ${gamePath}`);

let ok: boolean;

if (args.goal === "reach") {
  if (args.transcript) fail("--transcript is not available with --goal reach.");
  out(`Mode: goal=reach`);
  const report = analyzeReachability(game);
  printReachabilityReport(report);
  emitJson(report);
  ok = report.verdict === "pass";
} else if (args.goal !== undefined) {
  if (args.goal !== "explore") {
    fail(`Unknown goal "${args.goal}" — valid goals: "explore", "reach".`);
  }
  out(`Mode: goal=explore (seed ${args.seed}, max-steps ${args.maxSteps})`);
  const transcript: TranscriptEntry[] = [];
  const report = runExplore(game, {
    maxSteps: args.maxSteps,
    seed: args.seed,
    onStep: (e) => transcript.push(e),
  });
  printExplorerReport(report);
  if (!report.win) printFailureDetail(report);
  if (args.transcript) writeTranscript(args.transcript, transcript);
  emitJson(report);
  ok = report.win;
} else {
  const source =
    args.script !== undefined
      ? readFileSync(resolveUserPath(args.script), "utf8")
      : args.actions!;
  const words = parseScriptWords(source);
  if (words.length === 0) fail("The script contains no actions.");
  out(
    `Mode: script (${words.length} actions from ${
      args.script ? resolveUserPath(args.script) : "--actions"
    }, seed ${args.seed}${args.strict ? ", strict" : ""})`,
  );
  const transcript: TranscriptEntry[] = [];
  const report = runScript(game, words, {
    seed: args.seed,
    strict: args.strict,
    onStep: (e) => transcript.push(e),
  });
  printScriptReport(report);
  if (!report.win) printFailureDetail(report);
  if (args.transcript) writeTranscript(args.transcript, transcript);
  emitJson(report);
  ok = report.win;
}

process.exit(ok ? 0 : 1);

// ---------------------------------------------------------------------------

function emitJson(report: ScriptReport | ExploreReport | ReachabilityReport): void {
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

function writeTranscript(path: string, entries: TranscriptEntry[]): void {
  const resolved = resolveUserPath(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  out(`Transcript: ${entries.length} entries written to ${resolved}`);
}

function printFailureDetail(r: ScriptReport | ExploreReport): void {
  out("\nLast 20 events:");
  for (const line of r.lastEvents) out(`  ${line}`);
  out("\nFinal observation:");
  out(r.finalObservation);
}

function printScriptReport(r: ScriptReport): void {
  const result = r.win
    ? "WIN"
    : r.stopReason === "stopped"
      ? `STOPPED — ${r.stopDetail}`
      : `NOT WON — ${r.stopDetail}`;
  out(`Result: ${result}`);
  out(`Steps executed: ${r.steps} of ${r.totalActions}`);
  out(`Turns: ${r.turns}`);
  out(
    `Final: map=${r.finalMap}, pos=(${r.finalX}, ${r.finalY}), money=${r.money}${r.inBattle ? ", in battle" : ""}`,
  );
  out(`Party: ${partyLine(r.party)}`);
  out(`Flags: ${r.flags.join(", ") || "(none)"}`);
  if (r.rejections.length > 0) {
    out(`Rejected steps: ${r.rejections.length} (harmless no-ops unless the run failed)`);
    for (const rej of r.rejections.slice(0, 10)) {
      out(`  step ${rej.step} (${rej.action}): ${rej.event}`);
    }
    if (r.rejections.length > 10) out(`  ... and ${r.rejections.length - 10} more`);
  }
}

function printExplorerReport(r: ExploreReport): void {
  out(`Result: ${r.win ? "WIN" : `INCOMPLETE — ${r.stopReason}: ${r.stopDetail}`}`);
  out(`Steps: ${r.steps} (turns: ${r.turns})`);
  out(
    `Maps visited (${r.mapsVisited.length}/${r.mapsVisited.length + r.mapsUnvisited.length}): ${r.mapsVisited.join(", ")}`,
  );
  if (r.mapsUnvisited.length > 0) {
    out(`Maps NOT reached: ${r.mapsUnvisited.join(", ")}`);
  }
  out(
    `Entities interacted: ${r.entitiesInteracted.length}/${r.entitiesTotal} unique (${r.interactionCount} interactions across flag-states)`,
  );
  out(`Flags set (${r.flags.length}): ${r.flags.join(", ") || "(none)"}`);
  out(
    `Battles: ${r.battles.fought} fought — ${r.battles.won} won, ${r.battles.lost} lost, ${r.battles.fled} fled`,
  );
  out(`Final: map=${r.finalMap}, pos=(${r.finalX}, ${r.finalY}), money=${r.money}`);
  out(`Party: ${partyLine(r.party)}`);
}

function printReachabilityReport(r: ReachabilityReport): void {
  out(`Verdict: ${r.verdict === "pass" ? "PASS" : "FAIL"} — ${r.summary}`);
  const total = r.maps.length;
  const opt = r.maps.filter((m) => m.optimistic).length;
  const pess = r.maps.filter((m) => m.pessimistic).length;
  out(`Start: ${r.start.map} (${r.start.x}, ${r.start.y})`);
  out(`Maps (optimistic ${opt}/${total} reachable, pessimistic ${pess}/${total}):`);
  for (const m of r.maps) {
    const note = !m.optimistic
      ? "  <- UNREACHABLE"
      : !m.pessimistic
        ? "  <- flag-gated"
        : "";
    out(
      `  ${m.id}: optimistic=${m.optimistic ? "yes" : "no"}, pessimistic=${m.pessimistic ? "yes" : "no"}${note}`,
    );
  }
  if (r.unreachableEntities.length > 0) {
    out(`Unreachable entities (${r.unreachableEntities.length}):`);
    for (const e of r.unreachableEntities) {
      out(`  ${e.id} (${e.name}) on ${e.map} at (${e.x}, ${e.y})`);
    }
  }
  if (r.flagGatedEntities.length > 0) {
    out(
      `Flag-gated entities (${r.flagGatedEntities.length}, reachable only once gates open): ${r.flagGatedEntities.map((e) => e.id).join(", ")}`,
    );
  }
  if (r.orphanPortals.length > 0) {
    out(`Orphan portals (${r.orphanPortals.length}):`);
    for (const p of r.orphanPortals) {
      out(
        `  ${p.map}.portals[${p.index}] at (${p.x}, ${p.y}) -> ${p.toMap} (${p.toX}, ${p.toY}): ${p.reason}`,
      );
    }
  }
  if (r.wildZoneIssues.length > 0) {
    out(`Wild zone issues (${r.wildZoneIssues.length}):`);
    for (const w of r.wildZoneIssues) out(`  ${w.map}: ${w.reason}`);
  }
}
