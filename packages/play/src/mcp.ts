import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Sim, observe, parseAction, validateGame } from "@llm-rpg/engine";
import { loadGame, resolveGamePath } from "./load.js";
import { DEFAULT_SLOT, readSave, writeSave } from "./saves.js";

/**
 * MCP server: the AI-facing interface to the engine.
 *   observe          -> grid + description of current state
 *   act {action}     -> apply one action, return events + new observation
 *   reset            -> restart the loaded game
 *   save_game {slot} -> write <gameDir>/saves/<slot>.json
 *   load_game {slot} -> resume from a slot (exact state, mid-battle included)
 *   validate_game    -> validate a game JSON document (the "build" tool)
 *
 * Start: tsx src/mcp.ts [path/to/game.json]
 */

const gamePath = resolveGamePath(process.argv[2]);
let sim = new Sim(loadGame(gamePath));

const server = new McpServer({ name: "llm-rpg", version: "0.1.0" });

server.tool(
  "observe",
  "Look at the current game state: map grid, goal, nearby entities, available actions.",
  {},
  async () => ({ content: [{ type: "text", text: observe(sim) }] }),
);

server.tool(
  "act",
  "Take one action in the game. Overworld: north/south/east/west/interact, plus lead1..lead6 to promote a party slot to the front (battles always open with slot 1; an in-battle switch does not reorder). Pending dialogue choice: choose1..choose9. Battle: move1..move4, switch1..switch6, item1..item9, catch, run.",
  {
    action: z.enum([
      "north", "south", "east", "west", "interact",
      "choose1", "choose2", "choose3", "choose4", "choose5",
      "choose6", "choose7", "choose8", "choose9",
      "move1", "move2", "move3", "move4",
      "switch1", "switch2", "switch3", "switch4", "switch5", "switch6",
      "item1", "item2", "item3", "item4", "item5", "item6", "item7", "item8", "item9",
      "catch", "run",
    ]),
  },
  async ({ action }) => {
    const parsed = parseAction(action)!;
    const events = sim.act(parsed);
    return {
      content: [{ type: "text", text: `${events.join("\n")}\n\n${observe(sim)}` }],
    };
  },
);

server.tool(
  "reset",
  "Restart the game from the beginning (rereads the game file, so edits are picked up).",
  {},
  async () => {
    sim = new Sim(loadGame(gamePath));
    return { content: [{ type: "text", text: `Game reset.\n\n${observe(sim)}` }] };
  },
);

server.tool(
  "save_game",
  'Save the current session to a named slot (default "quick"). Written to <gameDir>/saves/<slot>.json.',
  { slot: z.string().default(DEFAULT_SLOT).describe("Slot name: letters, digits, - and _") },
  async ({ slot }) => {
    try {
      const path = writeSave(gamePath, slot, sim);
      return { content: [{ type: "text", text: `Saved to ${path}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  "load_game",
  'Load a previously saved session from a slot (default "quick"). Resumes the exact state, mid-battle included.',
  { slot: z.string().default(DEFAULT_SLOT).describe("Slot name: letters, digits, - and _") },
  async ({ slot }) => {
    try {
      const loaded = readSave(gamePath, slot, loadGame(gamePath));
      sim = loaded.sim;
      const warnings = loaded.warnings.map((w) => `Warning: ${w}\n`).join("");
      return {
        content: [
          { type: "text", text: `${warnings}Loaded save "${slot}".\n\n${observe(sim)}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  "validate_game",
  "Validate a game definition JSON document. Returns actionable errors if invalid.",
  { json: z.string().describe("The full game document as a JSON string") },
  async ({ json }) => {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      return {
        content: [{ type: "text", text: `Not valid JSON: ${(err as Error).message}` }],
        isError: true,
      };
    }
    const result = validateGame(raw);
    const text = result.ok
      ? `Valid game: "${result.game!.meta.title}"`
      : `Invalid game:\n- ${result.errors.join("\n- ")}`;
    return { content: [{ type: "text", text }], isError: !result.ok };
  },
);

await server.connect(new StdioServerTransport());
