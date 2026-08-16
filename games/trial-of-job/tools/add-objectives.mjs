// Adds `set_objective` commands to games/trial-of-job/game.json.
//
// Every place a player can lose the thread is a place the game changes state
// without saying where to go next: the day rolls over, a flag opens a door
// somewhere else on the map, an act ends. This walks those exact transitions
// and appends a standing objective to each, so "what am I meant to be doing?"
// always has an answer on screen (and, with read-aloud, in the ear).
//
// Idempotent: running it twice replaces the objectives rather than stacking
// them, so it can be re-run after the source text changes.
import { readFileSync, writeFileSync } from "node:fs";

const PATH = new URL("../game.json", import.meta.url);
const game = JSON.parse(readFileSync(PATH, "utf8"));

const obj = (text) => ({ type: "set_objective", text });

/** Append an objective to a command list, replacing any already there. */
function setOn(commands, text, label) {
  if (!Array.isArray(commands)) throw new Error(`${label}: no command list`);
  const stripped = commands.filter((c) => c.type !== "set_objective");
  stripped.push(obj(text));
  commands.length = 0;
  commands.push(...stripped);
  return label;
}

const map = (id) => game.maps[id] ?? (() => { throw new Error(`no map ${id}`); })();
const trigger = (mapId, id) => {
  const t = (map(mapId).triggers ?? []).find((x) => x.id === id);
  if (!t) throw new Error(`no trigger ${mapId}:${id}`);
  return t;
};
const entity = (mapId, id) => {
  const e = map(mapId).entities.find((x) => x.id === id);
  if (!e) throw new Error(`no entity ${mapId}/${id}`);
  return e;
};

const done = [];

// ── Act I: the day loop ────────────────────────────────────────────────────
done.push(setOn(
  trigger("uz-estate", "act-one-open").commands,
  "Take care of two things on the farm. Then pray at the stone.",
  "act-one-open",
));
// Dusk (both maps) sends you to the altar; say so.
for (const [mapId, id] of [["uz-estate", "the-day-turns"], ["feast-house", "the-day-turns-indoors"]]) {
  const t = trigger(mapId, id);
  const stripped = t.commands.filter((c) => c.type !== "set_objective");
  // Gated exactly like the rest of the dusk beat, so it only fires at day's end.
  const gate = stripped.find((c) => c.type === "add_var" && c.var === "spent")?.when;
  stripped.push({ ...obj("Pray at the stone."), ...(gate ? { when: gate } : {}) });
  t.commands = stripped;
  done.push(id);
}
// Each offering opens the next day — except the third, which ends the act.
const altar = entity("uz-estate", "altar");
altar.interactions.forEach((i) => {
  const sets = (i.commands ?? []).filter((c) => c.type === "set_flag").map((c) => c.flag);
  if (sets.includes("offering_1") || sets.includes("offering_2")) {
    done.push(setOn(i.commands, "Take care of two more things on the farm.", "altar offering"));
  }
});
done.push(setOn(
  trigger("uz-estate", "court-of-heaven").commands,
  "Walk down to the road and go east.",
  "court-of-heaven",
));

// ── Act II & the mourning ──────────────────────────────────────────────────
done.push(setOn(
  trigger("uz-estate", "day-of-calamity").commands,
  "Go to the dust in the yard.",
  "day-of-calamity",
));

// ── Act III: the ash heap ──────────────────────────────────────────────────
done.push(setOn(trigger("ash-heap", "act-three-open").commands, "Go and talk to your wife.", "act-three-open"));
const wife = entity("ash-heap", "ash-wife");
for (const i of wife.interactions) {
  for (const c of i.commands ?? []) {
    if (c.type !== "choice") continue;
    for (const o of c.options) {
      const sets = (o.commands ?? []).filter((x) => x.type === "set_flag").map((x) => x.flag);
      if (sets.includes("held_integrity")) {
        done.push(setOn(o.commands, "Walk east across the ashes.", "held integrity"));
      }
    }
  }
}
done.push(setOn(trigger("ash-heap", "friends-arrive").commands, "Sit down in the ashes.", "friends-arrive"));
const seat = entity("ash-heap", "ash-seat");
for (const i of seat.interactions) {
  const sets = (i.commands ?? []).filter((c) => c.type === "set_flag").map((c) => c.flag);
  if (sets.includes("job_spoke")) {
    done.push(setOn(i.commands, "Answer your three friends. Say what is true.", "seventh day"));
  }
}
// Whoever closes the cycle opens Elihu.
for (const id of ["zophar"]) {
  for (const i of entity("ash-heap", id).interactions) {
    const walk = (cmds) => (cmds ?? []).some(
      (c) => (c.type === "set_flag" && c.flag === "round_two") ||
             (c.type === "choice" && c.options.some((o) => walk(o.commands))),
    );
    if (walk(i.commands)) {
      done.push(setOn(i.commands, "Go and talk to the young man waiting behind them.", "round two"));
    }
  }
}

// ── Act V: the whirlwind ───────────────────────────────────────────────────
for (const mapId of Object.keys(game.maps).filter((m) => m.startsWith("whirlwind-"))) {
  for (const t of map(mapId).triggers ?? []) {
    if (t.on === "enter") done.push(setOn(t.commands, "Walk to the stone in the storm.", `${mapId} enter`));
  }
}

// ── Act VI ─────────────────────────────────────────────────────────────────
done.push(setOn(
  trigger("uz-restored", "act-six-open").commands,
  "Pray for each of your three friends.",
  "act-six-open",
));
// Praying for any ONE friend opens the restoration, but the scene wants all
// three — so the objective only sends you to the yard once all three are done.
const ALL_PRAYED = {
  all: [{ flag: "prayed_eliphaz" }, { flag: "prayed_bildad" }, { flag: "prayed_zophar" }],
};
for (const id of ["eliphaz-restored", "bildad-restored", "zophar-restored"]) {
  for (const i of entity("uz-restored", id).interactions) {
    const sets = (i.commands ?? []).filter((c) => c.type === "set_flag").map((c) => c.flag);
    if (!sets.includes("friends_pardoned")) continue;
    const stripped = i.commands.filter((c) => c.type !== "set_objective");
    stripped.push({ ...obj("Walk down into the yard."), when: ALL_PRAYED });
    stripped.push({ ...obj("Pray for your other friends too."), when: { not: ALL_PRAYED } });
    i.commands = stripped;
    done.push(`${id} pardon`);
  }
}
done.push(setOn(trigger("uz-restored", "restoration").commands, "Go and stand in the gate.", "restoration"));

writeFileSync(PATH, JSON.stringify(game, null, 2) + "\n");
console.log(`objectives set at ${done.length} points:\n  ${done.join("\n  ")}`);
