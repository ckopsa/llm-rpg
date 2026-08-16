import { describe, expect, it } from "vitest";
import { validateGame, type Game } from "@llm-rpg/engine";
import { runExplore, runScript } from "../src/run.js";
import { analyzeReachability } from "../src/reachability.js";

/**
 * djt.2 (play side) — the `choice` command through the harness: runScript
 * replays choose actions and records bad ones as rejections, the explorer's
 * deterministic first-option policy (with its loop escape), and reachability
 * treating flags set inside choice options as obtainable.
 */

function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

/** Catalog-free narrative room: an oracle whose choice gates the win. */
function oracleFixture(oracleCommands: unknown[]): unknown {
  return {
    meta: { id: "oracle", title: "The Oracle", goal: "answer well" },
    legend: {
      "#": { name: "wall", glyph: "#", walkable: false },
      ".": { name: "floor", glyph: ".", walkable: true },
    },
    maps: {
      main: {
        rows: ["#####", "#...#", "#####"],
        entities: [
          {
            id: "oracle", name: "Oracle", glyph: "O", x: 2, y: 1,
            interactions: [{ commands: oracleCommands }],
          },
        ],
      },
    },
    player: { glyph: "@", map: "main", x: 1, y: 1 },
  };
}

const winningChoice = [
  { type: "say", text: "Speak." },
  {
    type: "choice",
    prompt: "What is the answer?",
    options: [
      { label: "Love", commands: [{ type: "win", text: "The oracle smiles." }] },
      { label: "Power", commands: [{ type: "say", text: "Wrong." }] },
    ],
  },
];

describe("runScript with choices", () => {
  it("flows choose actions through and wins", () => {
    const report = runScript(load(oracleFixture(winningChoice)), "interact choose1");
    expect(report.win).toBe(true);
    expect(report.rejections).toEqual([]);
    expect(report.lastEvents.some((e) => e.includes("1) Love"))).toBe(true);
  });

  it("records blocked actions and bad chooses as rejections", () => {
    const report = runScript(
      load(oracleFixture(winningChoice)),
      "east interact west choose9 choose2 choose1",
    );
    expect(report.win).toBe(false); // choose1 after resolution: no choice pending
    const events = report.rejections.map((r) => r.event);
    expect(events.some((e) => e.startsWith("A choice is before you"))).toBe(true);
    expect(events.some((e) => e.startsWith("There is no option 9"))).toBe(true);
    expect(
      events.some((e) => e.startsWith("There is no choice to make right now")),
    ).toBe(true);
  });
});

describe("explorer choice policy", () => {
  it("picks the first option deterministically", () => {
    const report = runExplore(load(oracleFixture(winningChoice)), { maxSteps: 50 });
    expect(report.win).toBe(true);
    expect(report.stopReason).toBe("won");
  });

  /** Depth-n chain of IDENTICAL choices: option 1 descends one level (or ends
   *  with a say at the bottom), and `secondOption`, when given, is appended so
   *  every level presents the same two labels. State never changes, so every
   *  presentation looks identical to the explorer's loop detector. */
  function identicalChain(depth: number, secondOption?: unknown): unknown {
    const bottom: unknown[] = [{ type: "say", text: "..." }];
    let inner: unknown[] = bottom;
    for (let i = 0; i < depth; i++) {
      const options: unknown[] = [{ label: "Again", commands: inner }];
      if (secondOption) options.push(secondOption);
      inner = [{ type: "choice", prompt: "Again?", options }];
    }
    return inner[0];
  }

  it("escapes a first-option loop by trying the next option", () => {
    // Every level looks identical; option 2 wins. After 3 identical
    // first-option picks the explorer switches to option 2.
    const looping = [
      identicalChain(6, {
        label: "Enough",
        commands: [{ type: "win", text: "Done." }],
      }),
    ];
    const report = runExplore(load(oracleFixture(looping)), { maxSteps: 100 });
    expect(report.win).toBe(true);
    expect(report.steps).toBeLessThan(20);
  });

  it("stalls out (bounded) when the only option loops identically", () => {
    const endless = [identicalChain(8)];
    const report = runExplore(load(oracleFixture(endless)), { maxSteps: 500 });
    expect(report.win).toBe(false);
    expect(report.stopReason).toBe("stalled");
    expect(report.stopDetail).toContain("Again?");
    expect(report.steps).toBeLessThan(50);
  });
});

describe("reachability with choice-set flags", () => {
  it("treats a gate whose flag is set only inside a choice option as passable", () => {
    const raw = {
      meta: { id: "gated", title: "Gated", goal: "pass the guard" },
      legend: {
        "#": { name: "wall", glyph: "#", walkable: false },
        ".": { name: "floor", glyph: ".", walkable: true },
      },
      maps: {
        main: {
          rows: ["######", "#....#", "######"],
          entities: [
            {
              id: "keeper", name: "Keeper", glyph: "K", x: 1, y: 1, blocking: false,
              interactions: [
                {
                  commands: [
                    {
                      type: "choice",
                      prompt: "Swear the oath?",
                      options: [
                        {
                          label: "Swear",
                          commands: [{ type: "set_flag", flag: "sworn" }],
                        },
                        { label: "Refuse", commands: [{ type: "say", text: "Go." }] },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              id: "guard", name: "Guard", glyph: "G", x: 3, y: 1,
              passableWithFlag: "sworn",
              interactions: [{ commands: [{ type: "say", text: "Sworn, then." }] }],
            },
            {
              id: "shrine", name: "Shrine", glyph: "S", x: 4, y: 1, blocking: false,
              interactions: [{ commands: [{ type: "win", text: "You pray." }] }],
            },
          ],
        },
      },
      player: { glyph: "@", map: "main", x: 2, y: 1 },
    };
    // The flag write lives only inside a choice option: no validation warning
    // (validateGame harvests writes recursively) ...
    const validation = validateGame(raw);
    expect(validation.ok).toBe(true);
    expect(validation.warnings).toEqual([]);
    // ... and the optimistic pass reaches past the guard.
    const report = analyzeReachability(load(raw));
    expect(report.verdict).toBe("pass");
    expect(report.unreachableEntities).toEqual([]);
    expect(report.flagGatedEntities.map((e) => e.id)).toContain("shrine");
  });
});
