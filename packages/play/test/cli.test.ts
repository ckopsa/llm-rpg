import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PLAY = join(ROOT, "packages/play");

/** Run the playtest CLI as a subprocess (tsx loader, like `npm run playtest`).
 *  Resolves even on non-zero exit codes, returning them alongside stdio. */
async function playtest(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      ["--import", "tsx", join(PLAY, "src/playtest.ts"), ...args],
      { cwd: PLAY, encoding: "utf8" },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("playtest --json", () => {
  it("reach mode: stdout is pure parseable JSON, human report on stderr", async () => {
    const { code, stdout, stderr } = await playtest(
      "--game",
      join(ROOT, "games/demo/game.json"),
      "--goal",
      "reach",
      "--json",
    );
    expect(code).toBe(0); // demo passes reachability
    const report = JSON.parse(stdout); // throws if anything else leaked to stdout
    expect(report.verdict).toBe("pass");
    expect(report.maps.map((m: { id: string }) => m.id)).toEqual(["village", "east-road"]);
    expect(stderr).toContain("== PLAYTEST REPORT ==");
    expect(stderr).toContain("Verdict: PASS");
  }, 30_000);

  it("script mode: emits the ScriptReport as JSON and exits 1 on a non-win", async () => {
    const { code, stdout } = await playtest(
      "--game",
      join(ROOT, "games/demo/game.json"),
      "--actions",
      "north east",
      "--json",
    );
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.mode).toBe("script");
    expect(report.win).toBe(false);
    expect(report.totalActions).toBe(2);
    expect(report.game.id).toBe("ironwood-village");
    expect(typeof report.finalObservation).toBe("string");
  }, 30_000);

  it("without --json, stdout carries the human report", async () => {
    const { code, stdout } = await playtest(
      "--game",
      join(ROOT, "games/emberwood/game.json"),
      "--goal",
      "reach",
    );
    expect(code).toBe(0); // clean since vespera steps aside (see reachability.test.ts)
    expect(stdout).toContain("== PLAYTEST REPORT ==");
    expect(stdout).toContain("Maps (optimistic 10/10 reachable, pessimistic 2/10):");
  }, 30_000);
});
