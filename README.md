# llm-rpg

[![CI](https://github.com/ckopsa/llm-rpg/actions/workflows/ci.yml/badge.svg)](https://github.com/ckopsa/llm-rpg/actions/workflows/ci.yml)

A 2D RPG engine designed for LLMs to **build** and **play** — and for humans to play the same games in a browser.

**▶ Play in your browser: https://ckopsa.github.io/llm-rpg/** — works on a phone (on-screen d-pad), a
gamepad, or a keyboard. Try [The Trial of Job](https://ckopsa.github.io/llm-rpg/?game=trial-of-job),
or the [simple-words retelling](https://ckopsa.github.io/llm-rpg/?game=trial-of-job&lang=simple)
written for a young listener — press **V** to have it read aloud.

**Core idea: everything is data.** A game is one JSON document (maps, tiles, portals, entities, interactions, encounter tables). The engine validates it with actionable error messages, simulates it deterministically, and renders it two ways: as text for AI players, as a grid for human players. Both views run the identical engine on the identical file.

## Layout

```
packages/engine   Pure TypeScript: zod schema + validator, deterministic sim, text observer
packages/play     AI-facing interfaces: CLI (interactive + replay mode), MCP server
apps/web          Human-facing renderer: Vite app, arrow keys + emoji grid
games/demo        Ironwood Village — a game is just a JSON file in a directory
```

## Accessibility

The browser renderer reads itself aloud (**V**), so a player who cannot read yet can still play:
dialogue, long-form passages, the choice menu and the endings are all spoken, and pacing follows the
voice rather than a timer — passages turn their own pages. Movement chatter is deliberately not read.

Two speech backends, local first: a [Piper](https://github.com/OHF-Voice/piper1-gpl) neural voice
served by the dev server (offline, ~130 ms a line — see `apps/web/tools/piper-server.py`), falling
back to the browser's own Web Speech voices. The local one exists because Web Speech is not
dependable on Linux: Chromium-family browsers delegate to speech-dispatcher, and de-Googled builds
expose no voices at all. On the hosted build above there is no server, so the browser's voices are
used — which works well on Android and iOS.

Games can also ship alternative scripts (`games/<id>/lang.<code>.json`): the same maps, entities and
flags, different words. `?lang=simple` on The Trial of Job is a retelling for a five-year-old.

## License

Source code is MIT (see [LICENSE](LICENSE); third-party terms in [NOTICE](NOTICE)). The bundled art is **not** — some sheets are CC0 and the
battler sprites are CC-BY 3.0 and require attribution; see
[apps/web/public/assets/LICENSES.md](apps/web/public/assets/LICENSES.md). Scripture quoted in
`games/trial-of-job/` is the World English Bible, which is public domain.

## Quick start

```bash
npm install
npm test                      # engine tests incl. a full deterministic playthrough

# Human, terminal: interactive REPL (n/s/e/w/i, q to quit)
npm run play

# Human, browser: arrows/WASD to move, E to interact
npm run web                   # then open the printed localhost URL

# AI, stateless: replay an action sequence, print the final observation.
# Determinism (seed + actions) means an agent plays by re-invoking with one more action each time.
# This script wins the demo, wild battle included:
npm run play -- --actions "east,east,east,east,east,east,north,north,north,north,interact,south,south,south,south,east,east,east,east,east,east,east,move1,move1,move1,west,west,west,west,west,interact"

# Validate a game file (the build-side feedback loop)
npm run validate -- games/demo/game.json
```

**Saves.** In the interactive CLI, `save [slot]` / `load [slot]` write and read `<gameDir>/saves/<slot>.json` (default slot `quick`; `saves/` is gitignored). Replay mode can resume from a save: `npm run play -- --from quick --actions "east,east"`. A save records `{ gameId, gameVersion, snapshot }`; loading a save from a different game id fails with an actionable error, a different version warns but loads. Mid-battle saves restore exactly — same RNG, same battle round.

## Playtesting

`npm run playtest` plays a game automatically and reports either a win with stats or "stuck here" with a diagnosis (last 20 events + the full final observation). Exit code 0 only on a win, so it slots straight into CI. `--transcript <file>` (script/explore) writes the complete event log as JSONL: one `{step, action, events, map, battle}` object per action. `--json` (any mode) prints the report as a single JSON object — the only thing written to stdout; the human-readable report moves to stderr — so build tools can pipe it straight into a parser.

**Script mode** replays a known action list (whitespace/comma-separated; `#` comments to end of line in script files):

```bash
npm run playtest -- --game games/emberwood/game.json --script my-run.txt
npm run playtest -- --game games/demo/game.json --actions "n n e interact"
```

The report covers win/loss, turns, steps executed, final map/position/party/money, a per-battle `battleDetails` list (opponent, enemy party, start/end step, result, and the party's levels/HP right after — how you diagnose exactly which fight was lost and to whom), and every rejected action (blocked moves, battle/overworld mode mismatches, invalid battle choices). `--tail N` widens the kept event window (default 20). Rejections are recorded but don't stop the run by default — verified scripts legitimately contain harmless no-ops such as wall bumps that fish for wild encounters; pass `--strict` to stop at the first rejection instead. Unknown action words always stop the run. For a catalog-free narrative game, reaching **any** ending counts as success (`completed: true`, exit code 0); catalog games keep the strict `win` bar.

**Goal mode** needs no script — a deterministic built-in explorer BFS-pathfinds over walkable tiles (through portals) to interact with every reachable entity once per flag-state, step into every reachable map, walk onto every unfired step-trigger tile, and fight battles greedily (highest-power usable move, switch on faint, catch nothing, run from wild battles near a wipe). When it stops `exhausted`, the stopDetail names the likely blockers it knows about — trainers it gave up on (their `defeatFlag` unearned) and still-closed `passableWithFlag` gates:

```bash
npm run playtest -- --game games/emberwood/game.json --goal explore --max-steps 2000
```

It won't beat a tuned game — its job is coverage smoke-testing. The report lists maps visited (and NOT reached), entities interacted, flags set, battles fought/won/lost/fled, and exactly where and why it stopped. This is the first thing to run on new content: unreachable maps and broken flag gates show up immediately. Runs are fully reproducible (`--seed`, default 1; all tie-breaks are stable ordering).

**Reachability mode** is the instant build-critic — a static BFS from the player start through walkable tiles and portals, with no simulation at all (no battles, no encounters, no RNG), so it finishes in milliseconds:

```bash
npm run playtest -- --game games/emberwood/game.json --goal reach
```

It runs two passes over the same graph: **optimistic** (entities with `passableWithFlag` are treated as already open, since their flag may become obtainable — anything unreachable here is a hard authoring bug) and **pessimistic** (blocking entities never open). The delta between them shows exactly which content sits behind flag gates — expected for badge gates, alarming for your starter town. `teleport_player` commands count as edges: a destination is reachable once the teleport's host entity/trigger is (gated teleports fire in the optimistic pass only); the report lists every edge in `teleports`. The report covers per-map reachability under both passes, entities no reachable tile is adjacent to (`interact` can never target them), orphan portals (never enterable from the start, or with an invalid destination), encounter zones with no reachable wild tile, and a `limitations` list stating what the static pass cannot see (runtime `set_tile`/`spawn_entity`/`remove_entity`/`move_entity` overlays are not simulated — the explore playtest is the dynamic check). Exit code 0 only when the optimistic pass is clean. Run it after every map edit; save `--goal explore` for when the wiring is right.

**As a library:** `@llm-rpg/play` exports the same machinery for in-process callers (e.g. the MCP forge loop): `runScript(game, actions, opts)` → `ScriptReport`, `runExplore(game, opts)` → `ExploreReport`, and `analyzeReachability(game)` → `ReachabilityReport`. All three reports are plain JSON-serializable objects — exactly what `--json` prints.

`packages/engine/test/emberwood.test.ts` pins both play loops in CI (Emberwood's README script must still win at turn 1242, and the explorer must fully cover and win the demo game); `packages/play/test/` pins the report shapes and the reachability analyzer against both shipped games.

## MCP server (AI plays via tool calls)

```bash
claude mcp add llm-rpg -- npm run mcp --prefix /path/to/llm-rpg
```

Tools: `observe`, `act`, `reset`, `save_game {slot}`, `load_game {slot}`, `validate_game`.

## Forge (AI builds games via tool calls)

The Forge is the authoring-side MCP server: tools that create and edit `games/<dir>/game.json` incrementally, with every accepted edit atomically persisted (and undoable), advisory validation on every response, and the playtest harness one tool call away:

```bash
claude mcp add llm-rpg-forge -- npm run forge --prefix /path/to/llm-rpg
```

Tools: `forge_list_games`, `forge_new_game` (from `games/_templates/starter` — a minimal complete, winnable teaching game — or `blank`), `forge_open`, `forge_edit` / `forge_batch` (the engine's edit ops: meta, maps, painting, entities, dialogue, triggers, variants, portals, encounters, catalog — `removeCatalog` turns a blank draft into a catalog-free narrative game), `forge_undo`, `forge_map`, `forge_overview`, `forge_validate`, `forge_check` (instant reachability critic, teleport-aware), `forge_playtest` (explore / script / reach).

**[docs/forge.md](docs/forge.md)** is the authoring guide: the recommended workflow (edit → `forge_check` → explore playtest → fix), an op reference, schema conventions (flag gating, spatial shops), and pacing/tone heuristics.

## Game format in 30 seconds

A game is a multi-map overworld (towns, routes, interiors) connected by portals, with a shared tile legend and an embedded creature catalog:

```jsonc
{
  "meta": { "id": "...", "title": "...", "goal": "what winning means" },
  "catalog": {                                    // one document, one truth (optional — omit it for a battle-free narrative game)
    "typeChart": { "types": ["fire", "..."], "effectiveness": { "fire": { "grass": 2 } } },
    "moves":   [{ "id": "flamejet", "name": "Flamejet", "type": "fire", "power": 40, "accuracy": 1, "pp": 25 }],
    "species": [{ "id": "emberling", "name": "Emberling", "glyph": "🦎", "types": ["fire"],
                  "baseStats": { "hp": 44, "atk": 52, "def": 43, "spd": 65 },
                  "learnset": [{ "level": 1, "moveId": "flamejet" }],
                  "evolvesTo": { "speciesId": "pyrewyrm", "level": 16 },
                  "catchRate": 0.45, "xpYield": 62 }],
    "items":   [{ "id": "embersalve", "name": "Embersalve", "kind": "heal", "amount": 20 },
                { "id": "kindling-snare", "name": "Kindling Snare", "kind": "capture", "ballMod": 1 }]
  },
  "legend": {
    "#": { "name": "tree", "glyph": "🌲", "walkable": false },
    "*": { "name": "tall grass", "glyph": "🌿", "walkable": true, "wild": true }  // encounter tile
  },
  "maps": {
    "village": {
      "rows": ["####", "#..#", "####"],          // chars index into legend
      "entities": [{
        "id": "elder", "name": "Elder Maren", "glyph": "🧙", "x": 2, "y": 1,
        "interactions": [
          { "requiresFlag": "blessing", "commands": [{ "type": "win", "text": "..." }] },
          { "forbidsFlag": "blessing",  "commands": [   // skipped once the flag is set
            { "type": "say", "text": "..." },
            { "type": "give_species", "speciesId": "emberling", "level": 7 },
            { "type": "give_item", "itemId": "embersalve", "qty": 2 },
            { "type": "give_money", "amount": 25 },
            { "type": "set_flag", "flag": "blessing" }
          ] }
        ]
      }],
      "portals": [{ "x": 2, "y": 1, "toMap": "route-1", "toX": 1, "toY": 1 }]  // step on -> transfer
    },
    "route-1": {
      "rows": ["####", "#**#", "####"],
      "entities": [], "portals": [],
      "encounters": {                             // required iff the map has wild tiles
        "rate": 0.2,                              // chance per step onto a wild tile
        "table": [{ "speciesId": "emberling", "minLevel": 2, "maxLevel": 4, "weight": 3 }]
      }
    }
  },
  "player": {
    "glyph": "🙂", "map": "village", "x": 1, "y": 1,
    "party": [],                                  // up to 6 { speciesId, level }
    "money": 20, "inventory": [],                 // [{ itemId, qty }]
    "respawn": { "map": "village", "x": 1, "y": 1 }  // where defeat wakes you (default: start)
  }
}
```

Interactions are checked in order; the first one whose `requiresFlag` is satisfied *and* whose `forbidsFlag` is not set *and* whose `when` (if any) evaluates true runs (`forbidsFlag` makes one-time gifts — e.g. three starter pedestals that all set `starter_chosen`). Commands: `say`, `set_flag`, `set_var`, `add_var`, `passage`, `choice`, `win`, `end`, `give_species`, `give_item`, `give_money`, `heal_party`, `sell`, plus the cutscene/world set — `move_entity`, `spawn_entity`, `remove_entity`, `set_tile`, `teleport_player`, `set_variant`, `wait`, `camera_focus`, `play_music`, `screen_effect`, `show_title` (each described below). Entities can set `"passableWithFlag": "some_flag"` to stop blocking once a flag is set. `validateGame` cross-checks everything against the catalog (encounter species, item/species refs in commands, trainer parties, party members) with errors that name the fix, and warns about flags/vars that are read but never written.

**Vars and `when` conditions.** Alongside boolean flags, games have named variables: `{ "type": "set_var", "var": "trust", "value": 3 }` (numbers or strings) and `{ "type": "add_var", "var": "trust", "amount": 1 }` (numeric; a missing var starts at 0; adding to a text var is a validation error where statically knowable, a runtime event otherwise). Every command and every interaction takes an optional `when` — a unified condition object, evaluated by the exported `evalWhen(ctx, when)`:

```jsonc
{ "flag": "blessed" }                                  // flag is set
{ "notFlag": "blessed" }                               // flag is not set
{ "var": "trust", "op": "gte", "value": 2 }            // eq|ne|lt|lte|gt|gte
{ "all": [ ... ] }  { "any": [ ... ] }  { "not": ... } // composition, nests freely
```

A command whose `when` is false is skipped silently; an interaction's `when` is ANDed with the `requiresFlag`/`forbidsFlag` sugar. Var comparisons against a missing var see `0` (number comparisons) or `""` (string comparisons); `"money"` is a built-in readable var (the player's money — writable only through `give_money`/`sell`). Vars live in `state.vars`, are snapshot-safe, and print in observations.

**Passages** are long-form text (poetry, narration, scripture) that the plain `say` chatter box would mangle: `{ "type": "passage", "title": "…", "lines": ["…", "…"], "citation": "…" }` (title/citation optional, `lines` required). The passage lands in `state.lastPassages` (cleared each action, like `lastEvents`) for renderers that want a proper text pane, and as one formatted multi-line event (title, blank line, lines, `— citation`) so the CLI/MCP/text observers show it in full with zero changes.

**Choices** put a real decision in a dialogue:

```jsonc
{ "type": "choice", "prompt": "What do you answer?", "options": [
  { "label": "Hold fast", "commands": [{ "type": "set_flag", "flag": "held_fast" }] },
  { "label": "Curse",     "when": { "notFlag": "vowed" }, "commands": [{ "type": "say", "text": "..." }] }
] }
```

Presenting a choice **suspends** the rest of the current command list and shows the options whose `when` passes (an option with a failing gate is hidden; if none are open, an event explains it and the choice is skipped — validation warns when every option is gated). The sim then accepts only `choose1..chooseN` (alias `o1..oN`); everything else is rejected with a pointer at the options, and battles can't start. The chosen option's commands run first, then the suspended commands resume — so `say → choice → say-epilogue` reads the way you'd expect; a choice inside an option nests the same way. Choices are overworld-only (a validation error inside trainer `rewardCommands`), fully deterministic, and snapshot-safe mid-choice. The text observer lists the prompt and numbered options and swaps the actions line to `Actions: choose1..chooseN`.

**Triggers** fire command lists from the world instead of from `interact`. Each map takes `"triggers": [{ "id", "on": "enter" | "step", "tiles": [{x,y}], "once": true, "when": …, "commands": […] }]`:

- `enter` fires on **arriving on the map**: game start (for the start map — its events are in `lastEvents` before the first action), portal arrival, and `teleport_player` arrival. Respawn after a party wipe does not count.
- `step` fires when the player **lands on one of `tiles`** (required for step, invalid for enter) — by walking or by portal arrival on that tile.
- `once` (default true) fires at most once per game, tracked in `state.firedTriggers` (`"mapId:id"`, snapshot-safe). A trigger whose `when` fails is skipped *without* being marked fired, so it can fire later. Ids are unique per map; step tiles are bounds-checked; commands get the full cross-check recursion.

Trigger commands run through the same pipeline as interactions, so `choice`/`passage` inside triggers just work (a trigger-sourced choice locks the sim to `choose1..N` exactly like a dialogue one). Trigger `say` lines print **bare** (narrator voice — there is no speaker). Two ordering rules: a battle engaging on the same move (wild or line-of-sight) wins — the trigger is skipped and, if `once`, stays unfired; and a trigger firing while commands are already pending (a `teleport_player` mid-list, or mid-choice) **queues its commands after all pending work**, continuations included.

**Cutscenes** are just command lists — usually inside triggers. The sequence commands (all snapshot-safe, all deterministic, all taking `when`):

- `move_entity { entityId, path: ["north", …] }` walks an entity tile-by-tile; a blocked step (out of bounds, unwalkable, occupied by an entity or the player) stops the remaining movement with an event.
- `spawn_entity { mapId?, entity }` / `remove_entity { entityId }` add and remove entities at runtime (default map: the player's current one; duplicate ids are a validation error against placed entities, a runtime event otherwise).
- `set_tile { mapId?, x, y, char }` repaints one tile to another legend char — walkability and wildness follow the new char.
- `wait { beats }`, `camera_focus { entityId } | { mapId?, x, y } | { release: true }`, `play_music { track }`, `screen_effect { effect: "shake" | "flash" | "fade" }`, `show_title { text, subtitle? }` are renderer-directed pacing cues.

These world edits live in serializable sim state — `state.entityOverrides`, `state.spawnedEntities`, `state.tileOverrides` — and **every** read (movement, `interact`, trainer line of sight, observers, the grid) consults them. Renderer-directed commands additionally append structured records to `state.lastCues` (cleared each action, like `lastEvents`) so the web renderer can pace a cutscene with real timing; the sim's own state lands directly in the final post-sequence configuration, and text observers narrate the same sequence as ordered events for free.

**Endings and acts.** `end { "id", "text" }` finishes the game with a named ending: it sets `state.ending = { id, text }` and the sim refuses further actions exactly the way winning does. Only `id: "victory"` counts as *winning* (`state.won`); `win { text }` is now sugar for `end { id: "victory" }`, with its events and behavior unchanged. Multiple endings are legal — `validateGame` returns their ids as `endings`, and playtest reports carry `ending` (with `stopReason: "ended"` for non-victory finishes; `win` keeps its meaning). An ungated `end` must be the last command of its list; a `when`-gated one may sit anywhere. `teleport_player { mapId, x, y }` relocates the player (destination statically validated) and fires the target map's `enter` triggers; `show_title { text, subtitle? }` is the act/chapter card cue. Ending screens, title cards, and pacing belong to the renderer — the sim just emits the cues and events.

**Observed scenes (the heavenly-court pattern).** A cutscene may play on a map the player is not on — no extra machinery, because overlays are map-scoped and `camera_focus` accepts entities and tiles anywhere. The idiom, straight from the Book of Job:

```jsonc
{ "commands": [
  { "type": "show_title", "text": "Meanwhile", "subtitle": "In the court above" },
  { "type": "camera_focus", "entityId": "accuser" },          // an entity on the "court" map
  { "type": "passage", "lines": ["Whence comest thou?", "…"], "citation": "Job 1:7" },
  { "type": "move_entity", "entityId": "accuser", "path": ["east", "east"] },
  { "type": "set_flag", "flag": "wager_struck" },
  { "type": "camera_focus", "release": true }                 // return to the player
] }
```

The player never moves; the court map's overlays persist (the accuser stays where the scene left him); text observers narrate the whole scene as ordered events, and the web renderer paces it from `state.lastCues`.

**Narrative games (no catalog).** `catalog` is optional: a game without one is a story-first game — no battles, party, items, or encounters. Validation then errors, naming the fix, on anything battle-bound: wild tiles, `encounters` zones, `trainer` blocks, `give_species`/`give_item`/`sell` commands, and a non-empty starting `party`/`inventory`. Money and every narrative command still work (`heal_party` becomes a gentle no-op event); observers simply omit party lines, and the playtest explorer runs the same coverage sweep without a battle policy.

**Variants** give an entity conditional appearances — Job before and after the boils, the estate before and after ruin:

```jsonc
"variants": [
  { "id": "afflicted", "when": { "flag": "boils" }, "glyph": "j", "name": "Job the Afflicted", "sprite": "job-boils" },
  { "id": "restored",  "when": { "var": "fortune", "op": "gte", "value": 2 }, "glyph": "Ĵ", "name": "Job the Restored" }
]
```

The **first** variant whose `when` passes wins (one with no `when` always matches); fields the variant omits fall back to the base entity. `set_variant { "entityId", "variantId" }` forces a specific variant regardless of conditions — recorded in `state.variantOverrides`, snapshot-safe — until `set_variant { "entityId", "clear": true }` returns it to when-evaluation. Observers use the effective glyph/name **everywhere**: the grid, the nearby list, and dialogue speaker names (a `set_variant` mid-dialogue changes the speaker's name for the very next `say`). `sprite` is a web-manifest sprite id passed through untouched for the browser renderer. Validation enforces unique variant ids per entity and checks every `set_variant` reference.

**Shops** are spatial, not menus: a `sell` command (`{ "type": "sell", "itemId": "embersalve", "price": 10 }`) on a shopkeeper or counter-tile entity sells the player 1x that item per interact — one entity or interaction per item. Insufficient money produces an event naming the shortfall.

**Trainers.** An entity with a `trainer` block is a battling NPC:

```jsonc
"trainer": {
  "party": [{ "speciesId": "fluffit", "level": 4 }],      // 1..6, sent out in order
  "defeatFlag": "ivo_defeated",                           // set on the player's victory
  "lineOfSight": { "dir": "west", "range": 3 },           // optional auto-engage
  "rewardMoney": 40,                                      // optional coins on victory
  "rewardCommands": [{ "type": "give_item", "itemId": "warm-snare", "qty": 1 }],
  "intro": "Hey! My kindred need the exercise.",          // shouted at battle start
  "defeatText": "Well fought — take these for the road.", // said on losing to you
  "outro": "The grass gets livelier every week."          // post-defeat default chat
}
```

While `defeatFlag` is unset, interacting starts a trainer battle — and with `lineOfSight`, so does stopping within `range` tiles straight along `dir` from the trainer with no blocking tile/entity between (checked after every player move). Trainer battles allow no `run` and no `catch`; losing triggers the normal respawn flow, winning sets the flag, pays `rewardMoney`, runs `rewardCommands`, and says `defeatText`. A defeated trainer behaves like a normal NPC (its `interactions`; `outro` is the fallback line if it has none). Trainers don't engage a player with no battle-ready kindred.

**Battles.** Stepping onto a wild tile rolls the map's encounter table with the sim's seeded RNG (`new Sim(game, seed)`); a hit immediately starts a wild battle (`state.battle`). Trainer battles start via interact or line-of-sight (`state.battleTrainer` holds the trainer's entity id). While a battle is active only battle actions are accepted: `move1..move4` (`m1..m4`), `switch1..switch6` (`s1..s6`), `item1..item9` (nth inventory slot), `catch` (first capture item; alias `snare`; wild only), `run` (wild only). Victory grants XP per enemy faint (`floor(xpYield * enemyLevel / 5)`, cubic level curve `L^3`); a multi-member enemy party auto-sends its next kindred. Level-ups learn learnset moves (the oldest of 4 is replaced), and evolutions trigger when the battle ends. Catching rolls `clamp(catchRate * ballMod * (1.3 - hp/maxHp), 0.05, 0.95)`. Defeat heals the party, halves your money, and respawns you at `player.respawn`. Stepping into tall grass with no (conscious) kindred is blocked. The same seed and action list always replay the identical game — battles included.

**Save/load.** `sim.snapshot()` returns a plain-JSON snapshot (state + RNG + seed); `Sim.fromSnapshot(game, snapshot)` restores it exactly, active battle included. `makeSaveFile(sim)` / `loadSaveFile(game, data)` wrap it in `{ gameId, gameVersion, snapshot }` with the version guard.
