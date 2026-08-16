import { describe, expect, it } from "vitest";
import { applyLanguage, Sim, validateGame, type Game } from "../src/index.js";

/**
 * Language overlays: one game, many scripts. The structure is shared and only
 * the words change, so the tests care about (a) every kind of player-facing
 * string being reached, (b) the source game never being mutated, and (c) the
 * coverage reports that keep a translation honest as the source drifts.
 */
function load(raw: unknown): Game {
  const result = validateGame(raw);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.game!;
}

const fixture = (): unknown => ({
  meta: { id: "lang-test", title: "The Long Title", goal: "Walk east and speak." },
  legend: {
    "#": { name: "wall", glyph: "#", walkable: false },
    ".": { name: "floor", glyph: ".", walkable: true },
  },
  maps: {
    room: {
      rows: ["#####", "#...#", "#####"],
      entities: [
        {
          id: "elder",
          name: "The Elder",
          glyph: "E",
          x: 3,
          y: 1,
          blocking: true,
          variants: [{ id: "known", when: { flag: "met" }, name: "Old Miriam" }],
          interactions: [
            {
              commands: [
                { type: "say", text: "Good morrow to thee, traveller." },
                {
                  type: "passage",
                  title: "A Reading",
                  lines: ["First line of it.", "Second line of it."],
                  citation: "Somewhere 1:1",
                },
                {
                  type: "choice",
                  prompt: "How dost thou answer?",
                  options: [
                    { label: "Politely", commands: [{ type: "say", text: "Very well." }] },
                    { label: "Rudely", commands: [{ type: "set_flag", flag: "met" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      triggers: [
        {
          id: "open",
          on: "enter",
          commands: [
            { type: "show_title", text: "Chapter the First", subtitle: "In Which It Begins" },
          ],
        },
      ],
    },
  },
  player: { glyph: "@", map: "room", x: 1, y: 1 },
});

const overlay = {
  name: "Simple words",
  strings: {
    "The Long Title": "Short Title",
    "Walk east and speak.": "Go east. Say hi.",
    "The Elder": "The Old Lady",
    "Old Miriam": "Miriam",
    "Good morrow to thee, traveller.": "Hello!",
    "A Reading": "A Story",
    "First line of it.\nSecond line of it.": ["One line now."],
    "Somewhere 1:1": "from the story",
    "How dost thou answer?": "What do you say?",
    Politely: "Be nice",
    Rudely: "Be rude",
    "Very well.": "Okay!",
    "Chapter the First": "Part One",
    "In Which It Begins": "It Begins",
    wall: "wall",
    floor: "floor",
  },
};

describe("language overlays", () => {
  it("replaces every kind of player-facing string", () => {
    const game = load(fixture());
    const { game: out } = applyLanguage(game, overlay);
    expect(out.meta.title).toBe("Short Title");
    expect(out.meta.goal).toBe("Go east. Say hi.");
    const elder = out.maps.room.entities[0];
    expect(elder.name).toBe("The Old Lady");
    expect(elder.variants![0].name).toBe("Miriam");
    const cmds = elder.interactions[0].commands;
    expect(cmds[0]).toMatchObject({ text: "Hello!" });
    expect(cmds[1]).toMatchObject({
      title: "A Story",
      lines: ["One line now."],
      citation: "from the story",
    });
    expect(cmds[2]).toMatchObject({ prompt: "What do you say?" });
    expect((cmds[2] as { options: { label: string }[] }).options.map((o) => o.label)).toEqual([
      "Be nice",
      "Be rude",
    ]);
    expect(out.maps.room.triggers![0].commands[0]).toMatchObject({
      text: "Part One",
      subtitle: "It Begins",
    });
  });

  it("reaches strings nested inside choice options", () => {
    const { game: out } = applyLanguage(load(fixture()), overlay);
    const choice = out.maps.room.entities[0].interactions[0].commands[2] as {
      options: { commands: { text?: string }[] }[];
    };
    expect(choice.options[0].commands[0].text).toBe("Okay!");
  });

  it("never mutates the source game", () => {
    const game = load(fixture());
    const before = JSON.stringify(game);
    applyLanguage(game, overlay);
    expect(JSON.stringify(game)).toBe(before);
  });

  it("reports overlay keys that matched nothing", () => {
    const { unused } = applyLanguage(load(fixture()), {
      name: "x",
      strings: { ...overlay.strings, "a line nobody wrote": "..." },
    });
    expect(unused).toContain("a line nobody wrote");
  });

  it("reports source strings the overlay does not cover", () => {
    const { missing } = applyLanguage(load(fixture()), { name: "x", strings: {} });
    expect(missing).toContain("Good morrow to thee, traveller.");
    expect(missing).toContain("First line of it.\nSecond line of it.");
  });

  it("leaves uncovered strings in the original words rather than blanking them", () => {
    const { game: out } = applyLanguage(load(fixture()), { name: "x", strings: {} });
    expect(out.maps.room.entities[0].interactions[0].commands[0]).toMatchObject({
      text: "Good morrow to thee, traveller.",
    });
  });

  it("applies patches BEFORE strings, so spliced-in content is translated too", () => {
    const { game: out } = applyLanguage(load(fixture()), {
      ...overlay,
      patches: [
        {
          path: "maps.room.entities.0.interactions.0.commands.0",
          value: { type: "say", text: "Good morrow to thee, traveller." },
        },
      ],
    });
    expect(out.maps.room.entities[0].interactions[0].commands[0]).toMatchObject({ text: "Hello!" });
  });

  it("reports a patch whose path does not exist", () => {
    const { unused } = applyLanguage(load(fixture()), {
      name: "x",
      patches: [{ path: "maps.nowhere.entities.0.name", value: "x" }],
    });
    expect(unused).toContain("patch:maps.nowhere.entities.0.name");
  });

  it("produces a game that still validates and plays", () => {
    const { game: out } = applyLanguage(load(fixture()), overlay);
    const revalidated = validateGame(JSON.parse(JSON.stringify(out)));
    expect(revalidated.ok).toBe(true);
    const sim = new Sim(revalidated.game!);
    expect(sim.state.lastEvents.join(" ")).toContain("Part One");
    sim.act({ type: "move", dir: "east" });
    sim.act({ type: "interact" });
    expect(sim.state.lastEvents.join(" ")).toContain("Hello!");
    expect(sim.state.pendingChoice?.prompt).toBe("What do you say?");
  });
});
