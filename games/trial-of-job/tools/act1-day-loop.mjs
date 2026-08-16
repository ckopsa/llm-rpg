// llm-rpg-565.3 — rebuild Trial of Job Act I as a day loop.
//
// Three days in Uz. Each day you may TEND three things; the fourth act of the
// day is the offering at the altar, which closes it. You cannot reach everyone
// — 9 tendings across 8 people and animals — so who gets your hands is the
// player's only real freedom in Act I, and the calamity reads the ledger back.
import { readFileSync, writeFileSync } from "node:fs";

const PATH = new URL("../game.json", import.meta.url);
/** Tendings per day. Two of eight things, three days running: you reach six.
 *  Tighter is better — the budget is the whole mechanic. */
const BUDGET = 2;
const g = JSON.parse(readFileSync(PATH, "utf8"));
const uz = g.maps["uz-estate"];
const feast = g.maps["feast-house"];

const P = (lines, citation) => ({ type: "passage", lines, ...(citation ? { citation } : {}) });
const say = (text, when) => ({ type: "say", text, ...(when ? { when } : {}) });
const flag = (f) => ({ type: "set_flag", flag: f });
const spend = { type: "add_var", var: "spent", amount: 1 };
const ent = (id) => uz.entities.find((e) => e.id === id) ?? feast.entities.find((e) => e.id === id);

/** A tending: costs one of the day's three acts and deepens by one step.
 *  Depth is tracked with flags, not vars, so it stays out of the observer's
 *  `Vars:` line (the same reason the seven sits use silence_1..7). */
function tendChain(entity, beats, { voice = "say" } = {}) {
  const key = entity.id.replace(/-/g, "_");
  entity.interactions = [
    ...beats.map((commands, i) => ({
      ...(i > 0 ? { requiresFlag: `tended_${key}_${i}` } : {}),
      forbidsFlag: `tended_${key}_${i + 1}`,
      when: { var: "spent", op: "lt", value: BUDGET },
      commands: [...commands, spend, flag(`tended_${key}_${i + 1}`)],
    })),
    // Out of acts, or nothing left to give this one: a free look, no spend.
    { commands: [voice === "say" ? say(entity.restLine) : P([entity.restLine])] },
  ];
  delete entity.restLine;
}

// ── The tendings ────────────────────────────────────────────────────────────

const sheep = ent("flock-sheep");
sheep.restLine = "The sheep move over the hill like slow weather.";
tendChain(sheep, [
  [P(["The sheep move over the hill like slow weather.",
      "You walk the edge of them, counting, the way you have since you were younger than the boy who keeps them."])],
  [P(["The lame ewe is at the back of them again.",
      "You carry her the last of the way and set her down in the grass, and she does not thank you."])],
  [P(["Seven thousand.",
      "You have never once counted them all. You count them anyway, every time, and stop somewhere in the third thousand."])],
], { voice: "narrate" });

const camels = ent("camel-string");
camels.restLine = "Three thousand camels, kneeling in the shade, chewing.";
tendChain(camels, [
  [P(["Three thousand camels, kneeling in the shade, chewing.",
      "The drivers raise a hand to you and go back to the ropes."])],
  [P(["You check the pads of the lead camel's feet, one and then the other.",
      "Two more seasons in her. Maybe three."])],
  [P(["They are worth more than the house and everyone in it.",
      "You have never thought that before, and having thought it, you go back to the ropes."])],
], { voice: "narrate" });

const oxen = ent("yoke-of-oxen");
oxen.restLine = "The oxen lean into the yoke. The east field is nearly turned.";
tendChain(oxen, [
  [P(["The oxen lean into the yoke. The east field is nearly turned.",
      "You put your hand flat on the near one's shoulder and feel the whole animal working."])],
  [P(["Five hundred yoke.",
      "The furrows come out of the field straight, and you have never in your life been able to do that yourself."])],
  [P(["The east field is turned.",
      "Tomorrow the donkeys go out to feed beside them, the way they always do."])],
], { voice: "narrate" });

const boy = ent("shepherd-boy");
boy.restLine = "The hill is quiet, master. Nothing wants anything.";
tendChain(boy, [
  [say("Seven thousand, and I know the lame one by her walk.")],
  [say("My father kept them before me. He said you paid him in the bad year anyway, when nobody was paying anybody.")],
  [say("Master — if I am ever the one who has to come and tell you something, will you let me finish?")],
]);
boy.variants = [
  { id: "known", when: { flag: "tended_shepherd_boy_3" }, name: "The Boy Who Knows the Lame One" },
];

const zabad = ent("plowman");
zabad.restLine = "The field is where I left it, master.";
tendChain(zabad, [
  [say("Five hundred yoke turning the east field, and the donkeys feeding beside them.")],
  [say("You asked my name the first year I came. Nobody asks the second time.")],
  [say("The west field wants a week yet. I will be out there Thursday. Alone, if you want me.")],
]);

const wife = ent("wife");
wife.restLine = "Go on, then. The morning is going.";
tendChain(wife, [
  [say("Up before the birds again. Was the smoke straight?")],
  [say("Ten of them, and every one in a different house on a different day. I have stopped trying to keep the days.")],
  [say("You go up every morning for them. Do you ever go up for yourself?")],
]);

const son = ent("eldest-son");
son.restLine = "Sit, father. Or don't — but the wine is here either way.";
tendChain(son, [
  [say("Father, sit. The lamps are still lit and there is wine left.")],
  [say("It is my day. Tomorrow it is Elior's, and then hers, and by the time it comes round again it will be the rains.")],
  [say("You send for us and sanctify us every time. We know. We let you, because it is what you have instead of saying it.")],
]);

const daughter = ent("sister-at-feast");
daughter.restLine = "Tomorrow it is my second brother's house.";
tendChain(daughter, [
  [say("He sent for us at dawn, the way he always does. Tomorrow it is my second brother's house.")],
  [say("You never ask us what we did. You only offer for it. I would rather you asked.")],
  [say("Sit down. You are always standing in the doorway of this room.")],
]);

// ── The altar: the fourth act, and the only one that closes a day ───────────

const altar = ent("altar");
const offering = (n, dayLines) => ({
  ...(n > 1 ? { requiresFlag: `offering_${n - 1}` } : {}),
  forbidsFlag: `offering_${n}`,
  when: { var: "spent", op: "gte", value: BUDGET },
  commands: [
    ...(n === 1
      ? [P(["It came to pass, when the days of their feasting had run their course, that Job sent and sanctified them,",
            "and rose up early in the morning, and offered burnt offerings according to the number of them all.",
            "For Job said, “It may be that my sons have sinned, and renounced God in their hearts.” Job did so continually."],
           "Job 1:5, WEB")]
      : []),
    ...dayLines,
    flag(`offering_${n}`),
    { type: "set_var", var: "spent", value: 0 },
    { type: "add_var", var: "day", amount: 1 },
  ],
});

altar.interactions = [
  offering(1, [
    P(["Dawn. You go up before anyone is awake and offer for the seven sons.",
       "The smoke stands straight up, which means nothing, and you watch it anyway until it does not."]),
    P(["The second day. The feast has moved to your second son's house — you can see the smoke of their cooking from the altar stone."]),
  ]),
  offering(2, [
    P(["Dawn again, and the three daughters.",
       "You say their names out loud in order, the way you have every time, in case the saying is the part that counts."]),
    P(["The third day. Nothing is wrong. That is the whole of the news."]),
  ]),
  offering(3, [
    P(["Dawn, and the offering for the days you cannot see — the sins you have not been told about and never will be.",
       "It may be that they have sinned. It may be. You have done this so long that the doubt is part of the ritual and not an interruption of it."]),
  ]),
  // Reached before the day has run: the budget, made tangible.
  {
    forbidsFlag: "offering_3",
    commands: [
      P(["Not yet. Job offered when the days of their feasting had run their course — and this day has not run.",
         "There is still a day to spend. Go and put your hands on it."]),
    ],
  },
  { commands: [P(["The stone is cold and there is nothing left on it to burn."])] },
];

// ── The dog: ambient life, and Job 1:3's donkeys finally on the map ────────

uz.entities.push({
  id: "herd-dog",
  name: "The Herd Dog",
  glyph: "🐕",
  x: 2,
  y: 9,
  blocking: false,
  interactions: [
    { forbidsFlag: "calamity", commands: [P(["She works the flocks all morning and spends the afternoon walking the same square of grass, checking it."])] },
    { commands: [P(["She has not settled since the messengers came. She walks the square of grass and checks it and walks it again."])] },
  ],
});

uz.entities.push({
  id: "donkey-string",
  name: "The Donkeys",
  glyph: "🫏",
  x: 12,
  y: 9,
  blocking: false,
  interactions: [
    { commands: [P(["Five hundred she-donkeys, feeding beside the oxen, indifferent to all of it."])] },
  ],
});

// ── The clock: dusk, and the estate breathing ──────────────────────────────

// Dusk latches by pushing `spent` past the budget rather than by a second
// var — trigger-level `when` is gated before any trigger runs, so the latch
// has to live in this command list, where `when` is evaluated per command.
const AT_BUDGET = { var: "spent", op: "eq", value: BUDGET };
const duskCommands = (indoors) => [
  say(
    indoors
      ? "Outside the shutters the light goes out of the yard. In here the lamps carry on as if nothing has happened. You walk home in the dark."
      : "The light goes out of the yard. Whatever you did not get to today is still there tomorrow, which is the mercy of ordinary days.",
    AT_BUDGET,
  ),
  { type: "screen_effect", effect: "fade", when: AT_BUDGET },
  // The day ends where it ends and the morning starts at the altar — Job rose
  // early and offered. No walk home to key in, and the loop closes on itself.
  { type: "teleport_player", mapId: "uz-estate", x: 4, y: 6, when: AT_BUDGET },
  say("Dawn. You are up before the household, at the stone, the way you always are.", AT_BUDGET),
  { type: "add_var", var: "spent", amount: 1, when: AT_BUDGET },
];

uz.triggers.push({
  id: "the-day-turns",
  on: "turn",
  once: false,
  when: { notFlag: "wager_struck" },
  commands: [
    ...duskCommands(false),
    // llm-rpg-565.2 — the estate is never still. Ambient motion goes on
    // something the player never needs to reach: a wandering TENDABLE entity
    // walks away from you mid-approach, which reads as the world fighting you
    // rather than living. The dog patrols the southwest grass, out of the
    // traffic between the altar, the road and the feast house.
    { type: "add_var", var: "pulse", amount: 1 },
    { type: "move_entity", entityId: "herd-dog", path: ["east"], quiet: true, when: { var: "pulse", op: "eq", value: 1 } },
    { type: "move_entity", entityId: "herd-dog", path: ["south"], quiet: true, when: { var: "pulse", op: "eq", value: 2 } },
    { type: "move_entity", entityId: "herd-dog", path: ["west"], quiet: true, when: { var: "pulse", op: "eq", value: 3 } },
    { type: "move_entity", entityId: "herd-dog", path: ["north"], quiet: true, when: { var: "pulse", op: "eq", value: 4 } },
    { type: "set_var", var: "pulse", value: 0, when: { var: "pulse", op: "gte", value: 4 } },
  ],
});

feast.triggers = [
  { id: "the-day-turns-indoors", on: "turn", once: false, when: { notFlag: "wager_struck" }, commands: duskCommands(true) },
];

// ── The cold open: name the loop ───────────────────────────────────────────

const open = uz.triggers.find((t) => t.id === "act-one-open");
open.commands = [
  ...open.commands.filter((c) => c.type !== "say" || !c.text.startsWith("Ten children")),
  { type: "set_var", var: "day", value: 1 },
  say("Two things will get your hands today, and then the light will go. The rest keep until tomorrow — there is always a tomorrow, and there have been ten thousand of them."),
  say("When the day has run you will find yourself at the altar in the morning, the way you always do. Offer for the children there."),
];

// ── The calamity reads the ledger ──────────────────────────────────────────

const known = (f, name) => ({ id: "known", when: { flag: f }, name });
const cal = uz.triggers.find((t) => t.id === "day-of-calamity");
for (const c of cal.commands) {
  if (c.type !== "spawn_entity") continue;
  const e = c.entity;
  if (e.id === "messenger-1") e.variants = [known("tended_plowman_2", "Zabad, From the Plowing")];
  if (e.id === "messenger-2") e.variants = [known("tended_shepherd_boy_1", "The Boy From the Pasture")];
  if (e.id === "messenger-3") e.variants = [known("tended_camel_string_1", "A Driver You Have Seen at the Ropes")];
  if (e.id === "messenger-4") e.variants = [known("tended_eldest_son_1", "A Man From Your Son's House")];
}

/** Insert `cmds` immediately after the passage carrying `citation`. */
function after(citation, cmds) {
  const i = cal.commands.findIndex((c) => c.type === "passage" && c.citation === citation);
  if (i < 0) throw new Error(`no passage cited ${citation}`);
  cal.commands.splice(i + 1, 0, ...cmds);
}

after("Job 1:14–15, WEB", [
  say("It is Zabad. He was in the west field on Thursday, alone, because he told you he would be.",
      { flag: "tended_plowman_3" }),
  say("You asked this man his name once, years ago, and he has not forgotten that you did.",
      { all: [{ flag: "tended_plowman_2" }, { notFlag: "tended_plowman_3" }] }),
  say("A plowman. You never asked him anything, and now he is the only one left to ask.",
      { notFlag: "tended_plowman_2" }),
]);

after("Job 1:16, WEB", [
  say("The boy asked you once to let him finish. You let him finish.",
      { flag: "tended_shepherd_boy_3" }),
  say("He knew the lame one by her walk. He does not say anything about her.",
      { all: [{ flag: "tended_shepherd_boy_1" }, { notFlag: "tended_shepherd_boy_3" }] }),
  say("A boy from the hill. You could not have said, this morning, that you had a boy on the hill.",
      { notFlag: "tended_shepherd_boy_1" }),
]);

after("Job 1:17, WEB", [
  say("Two more seasons in her, you had thought. Maybe three.", { flag: "tended_camel_string_2" }),
  say("The ropes are still coiled where the drivers left them.",
      { all: [{ flag: "tended_camel_string_1" }, { notFlag: "tended_camel_string_2" }] }),
]);

after("Job 1:18–19, WEB", [
  say("He was standing in the doorway of that room three days ago and would not sit down.",
      { flag: "tended_eldest_son_1" }),
  say("She asked you to ask her what she had done. You offered for it instead.",
      { flag: "tended_sister_at_feast_2" }),
  say("You sanctified them every morning of their lives. It is the one thing you are certain you did.",
      { notFlag: "tended_eldest_son_1" }),
]);

writeFileSync(PATH, JSON.stringify(g, null, 2) + "\n");
console.log("act I rebuilt");
