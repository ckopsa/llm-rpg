/**
 * Forge dev plugin: the live game-authoring feedback loop.
 *
 * While `vite dev` runs, edits to games/<id>/{game.json,sprites.json} are
 * pushed to the browser as a custom HMR event (`forge:update`) instead of
 * the default full-page reload, and a tiny middleware (`/__forge/...`)
 * serves the raw file text fresh from disk so the client can re-validate
 * and hot-swap the running game without losing player state.
 *
 * Dev-server only (`apply: "serve"`): none of this exists in a prod build.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const WATCHED = new Set(["game.json", "sprites.json"]);
const ID_RE = /^[A-Za-z0-9._-]+$/;

export function forgePlugin(): Plugin {
  let gamesDir = "";

  /** { gameId, file } when `file` is a watched forge file, else null. */
  const forgeFile = (file: string): { gameId: string; file: string } | null => {
    const rel = path.relative(gamesDir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    if (parts.length !== 2 || !WATCHED.has(parts[1])) return null;
    return { gameId: parts[0], file: parts[1] };
  };

  return {
    name: "llm-rpg:forge",
    apply: "serve",

    configResolved(config) {
      // apps/web -> repo root -> games/
      gamesDir = path.resolve(config.root, "..", "..", "games");
    },

    configureServer(server) {
      // Watch every game dir, loaded by the app or not.
      server.watcher.add(gamesDir);

      server.middlewares.use("/__forge", (req, res) => {
        void (async () => {
          const url = (req.url ?? "").split("?")[0];
          res.setHeader("Cache-Control", "no-store");

          if (url === "/list") {
            const ids: string[] = [];
            try {
              for (const ent of await fs.readdir(gamesDir, { withFileTypes: true })) {
                if (!ent.isDirectory()) continue;
                try {
                  await fs.access(path.join(gamesDir, ent.name, "game.json"));
                  ids.push(ent.name);
                } catch {
                  /* dir without a game.json — not a game */
                }
              }
            } catch {
              /* games dir unreadable — empty list */
            }
            ids.sort();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(ids));
            return;
          }

          const m = /^\/games\/([^/]+)\/(game\.json|sprites\.json)$/.exec(url);
          const id = m ? decodeURIComponent(m[1]) : "";
          if (m && ID_RE.test(id)) {
            try {
              const text = await fs.readFile(path.join(gamesDir, id, m[2]), "utf8");
              res.setHeader("Content-Type", "application/json");
              res.end(text);
              return;
            } catch {
              /* fall through to 404 */
            }
          }
          res.statusCode = 404;
          res.end("not found");
        })();
      });
    },

    handleHotUpdate(ctx) {
      const hit = forgeFile(ctx.file);
      if (!hit) return;
      ctx.server.ws.send({ type: "custom", event: "forge:update", data: hit });
      // Suppress default HMR: these files are raw-glob imports with no accept
      // handler, so Vite would otherwise full-reload the page and lose state.
      return [];
    },
  };
}
