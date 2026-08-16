/**
 * Piper dev plugin: local neural text-to-speech for read-aloud.
 *
 * The Web Speech API is not dependable on Linux — Chromium-family browsers
 * delegate to speech-dispatcher and de-Googled builds (Brave) answer `speak()`
 * with "synthesis-failed" and expose no voices at all. Read-aloud exists so a
 * player who can't read can play, so "depends on the browser's goodwill" is
 * not good enough.
 *
 * While `vite dev` runs, this spawns `tools/piper-server.py` (a Piper voice
 * loaded once, ~130ms for a three-second line) and proxies `/__tts/*` to it.
 * The browser only ever talks to the dev server, so it is same-origin, offline,
 * and no game text leaves the machine.
 *
 * Entirely optional: with no Python or no Piper voice installed the spawn
 * fails, `/__tts/health` 503s, and the client falls back to Web Speech.
 *
 * Dev-server only (`apply: "serve"`). For a static build, run the script
 * yourself and point VITE_TTS_URL at it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { Plugin } from "vite";

interface Ready {
  port: number;
  voice: string;
}

export function piperPlugin(): Plugin {
  let child: ChildProcessWithoutNullStreams | null = null;
  let ready: Ready | null = null;
  /** Resolves once the server has reported a port, or null if it can't start. */
  let starting: Promise<Ready | null> | null = null;

  const start = (root: string): Promise<Ready | null> => {
    const script = path.resolve(root, "tools", "piper-server.py");
    return new Promise((resolve) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn("python3", [script, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolve(null);
        return;
      }
      child = proc;
      let settled = false;
      const done = (value: Ready | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      // The server prints one JSON line with its port, then serves forever.
      let buf = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.ok) {
            ready = { port: msg.port, voice: msg.voice };
            console.log(`  \x1b[32m➜\x1b[0m  read-aloud: piper voice "${msg.voice}" on /__tts`);
            done(ready);
          } else {
            done(null);
          }
        } catch {
          done(null);
        }
      });
      proc.on("error", () => done(null));
      proc.on("exit", () => {
        ready = null;
        done(null);
      });
      // Don't let a wedged interpreter hold up the dev server.
      setTimeout(() => done(null), 15_000);
    });
  };

  const stop = () => {
    child?.kill();
    child = null;
    ready = null;
    starting = null;
  };

  return {
    name: "llm-rpg:piper",
    apply: "serve",

    configureServer(server) {
      const root = server.config.root;

      server.middlewares.use("/__tts", (req, res) => {
        void (async () => {
          starting ??= start(root);
          const live = ready ?? (await starting);
          res.setHeader("Cache-Control", "no-store");
          if (!live) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error:
                  "No local Piper voice. Install piper-tts and a voice, or rely on the browser's own speech.",
              }),
            );
            return;
          }
          const url = req.url ?? "/";
          try {
            const upstream = await fetch(`http://127.0.0.1:${live.port}${url}`);
            res.statusCode = upstream.status;
            res.setHeader(
              "Content-Type",
              upstream.headers.get("content-type") ?? "application/octet-stream",
            );
            res.end(Buffer.from(await upstream.arrayBuffer()));
          } catch (err) {
            // The child died between checks: forget it so the next request retries.
            stop();
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        })();
      });

      server.httpServer?.on("close", stop);
    },

    closeBundle: stop,
  };
}
