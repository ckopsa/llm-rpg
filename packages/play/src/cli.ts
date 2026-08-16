import { createInterface } from "node:readline/promises";
import { Sim, observe, parseAction } from "@llm-rpg/engine";
import { loadGame, resolveGamePath } from "./load.js";
import { DEFAULT_SLOT, readSave, writeSave } from "./saves.js";

/**
 * Two modes on purpose:
 *  - Interactive: a human types actions at a prompt. `save [slot]` /
 *    `load [slot]` write/read `<gameDir>/saves/<slot>.json` (default "quick").
 *  - --actions "east,east,interact": replays the whole sequence and prints the
 *    final observation. Because the sim is deterministic, a stateless agent can
 *    play a full game by re-invoking this with one more action each time.
 *    --from <slot> starts the replay from a save instead of the beginning.
 */

function parseArgs(argv: string[]) {
  let game: string | undefined;
  let actions: string | undefined;
  let from: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--game") game = argv[++i];
    else if (argv[i] === "--actions") actions = argv[++i];
    else if (argv[i] === "--from") from = argv[++i];
    else if (!argv[i].startsWith("--")) game = argv[i];
  }
  return { game, actions, from };
}

const { game: gameArg, actions, from } = parseArgs(process.argv.slice(2));
const gamePath = resolveGamePath(gameArg);
const game = loadGame(gamePath);

let sim: Sim;
if (from !== undefined) {
  try {
    const loaded = readSave(gamePath, from, game);
    for (const w of loaded.warnings) console.error(`Warning: ${w}`);
    sim = loaded.sim;
    console.log(`Loaded save "${from}" (${loaded.path}).`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
} else {
  sim = new Sim(game);
}

if (actions !== undefined) {
  for (const word of actions.split(/[,\s]+/).filter(Boolean)) {
    const action = parseAction(word);
    if (!action) {
      console.error(
        `Unknown action "${word}". Valid: north south east west interact | move1..4 switch1..6 item1..9 catch run`,
      );
      process.exit(1);
    }
    for (const ev of sim.act(action)) console.log(ev);
  }
  console.log();
  console.log(observe(sim));
  process.exit(sim.state.won ? 0 : 0);
} else {
  console.log(observe(sim));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = await rl.question("\n> ");
    const [word, arg] = line.trim().split(/\s+/);
    const cmd = (word ?? "").toLowerCase();
    if (cmd === "quit" || cmd === "q" || cmd === "exit") break;
    if (cmd === "save") {
      try {
        console.log(`Saved to ${writeSave(gamePath, arg ?? DEFAULT_SLOT, sim)}`);
      } catch (err) {
        console.log((err as Error).message);
      }
      continue;
    }
    if (cmd === "load") {
      try {
        const loaded = readSave(gamePath, arg ?? DEFAULT_SLOT, game);
        for (const w of loaded.warnings) console.log(`Warning: ${w}`);
        sim = loaded.sim;
        console.log(`Loaded save "${arg ?? DEFAULT_SLOT}".`);
        console.log(observe(sim));
      } catch (err) {
        console.log((err as Error).message);
      }
      continue;
    }
    const action = parseAction(cmd);
    if (!action) {
      console.log(
        "Valid actions: north south east west interact (n/s/e/w/i) | battle: move1..4 switch1..6 item1..9 catch run | save [slot] load [slot] quit",
      );
      continue;
    }
    sim.act(action);
    console.log(observe(sim));
    if (sim.state.won) break;
  }
  rl.close();
}
