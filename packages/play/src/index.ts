/** Library surface of @llm-rpg/play: the playtest harness callable
 *  in-process (script replay, coverage explorer, reachability analyzer)
 *  plus game loading helpers. The CLIs (playtest.ts, cli.ts, validate.ts,
 *  mcp.ts) are thin wrappers over these. */
export * from "./run.js";
export * from "./reachability.js";
export * from "./autoplay.js";
export { loadGame, resolveGamePath, resolveUserPath, DEFAULT_GAME } from "./load.js";
