import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGame, type Game } from "@llm-rpg/engine";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const DEFAULT_GAME = join(REPO_ROOT, "games/demo/game.json");

/** npm workspace scripts run with cwd inside the package; INIT_CWD is where
 *  the user actually invoked npm, so relative paths resolve from there. */
export function resolveUserPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

export function resolveGamePath(path?: string): string {
  if (!path) return DEFAULT_GAME;
  return resolveUserPath(path);
}

export function loadGame(path: string): Game {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read game file ${path}: ${(err as Error).message}`);
  }
  const result = validateGame(raw);
  if (!result.ok) {
    throw new Error(`Game file ${path} is invalid:\n  - ${result.errors.join("\n  - ")}`);
  }
  return result.game!;
}
