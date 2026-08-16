# llm-rpg

A 2D RPG engine designed for LLMs to **build** and **play** — and for humans to play the same games in a browser.

**Core idea: everything is data.** A game is one JSON document (maps, tiles, portals, entities, interactions, encounter tables). The engine validates it with actionable error messages, simulates it deterministically, and renders it two ways: as text for AI players, as a grid for human players. Both views run the identical engine on the identical file.

## Layout

```
packages/engine   Pure TypeScript: zod schema + validator, deterministic sim, text observer
packages/play     AI-facing interfaces: CLI (interactive + replay mode), MCP server
apps/web          Human-facing renderer: Vite app, arrow keys + emoji grid
games/demo        Ironwood Village — a game is just a JSON file in a directory
```

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

`npm run playtest` plays a game automatically and reports either a win with stats or "stuck here" with a diagnosis (last 20 events + the full final observation). Exit code 0 only on a win, so it slots straight into CI. `--transcript <file>` (either mode) writes the complete event log as JSONL: one `{step, action, events, map, battle}` object per action.

**Script mode** replays a known action list (whitespace/comma-separated; `#` comments to end of line in script files):

```bash
npm run playtest -- --game games/emberwood/game.json --script my-run.txt
npm run playtest -- --game games/demo/game.json --actions "n n e interact"
```

The report covers win/loss, turns, steps executed, final map/position/party/money, and every rejected action (blocked moves, battle/overworld mode mismatches, invalid battle choices). Rejections are recorded but don't stop the run by default — verified scripts legitimately contain harmless no-ops such as wall bumps that fish for wild encounters; pass `--strict` to stop at the first rejection instead. Unknown action words always stop the run.

**Goal mode** needs no script — a deterministic built-in explorer BFS-pathfinds over walkable tiles (through portals) to interact with every reachable entity once per flag-state, step into every reachable map, and fight battles greedily (highest-power usable move, switch on faint, catch nothing, run from wild battles near a wipe):

```bash
npm run playtest -- --game games/emberwood/game.json --goal explore --max-steps 2000
```

It won't beat a tuned game — its job is coverage smoke-testing. The report lists maps visited (and NOT reached), entities interacted, flags set, battles fought/won/lost/fled, and exactly where and why it stopped. This is the first thing to run on new content: unreachable maps and broken flag gates show up immediately. Runs are fully reproducible (`--seed`, default 1; all tie-breaks are stable ordering).

`packages/engine/test/emberwood.test.ts` pins both loops in CI: Emberwood's README script must still win at turn 1242, and the explorer must fully cover (and win) the demo game.

## MCP server (AI plays via tool calls)

```bash
claude mcp add llm-rpg -- npm run mcp --prefix /path/to/llm-rpg
```

Tools: `observe`, `act`, `reset`, `save_game {slot}`, `load_game {slot}`, `validate_game`.

## Game format in 30 seconds

A game is a multi-map overworld (towns, routes, interiors) connected by portals, with a shared tile legend and an embedded creature catalog:

```jsonc
{
  "meta": { "id": "...", "title": "...", "goal": "what winning means" },
  "catalog": {                                    // one document, one truth
    "typeChart": { "types": ["fire", "..."], "effectiveness": { "fire": { "grass": 2 } } },
    "moves":   [{ "id": "flamejet", "type": "fire", "power": 40, "accuracy": 1, "pp": 25 }],
    "species": [{ "id": "emberling", "baseStats": { "hp": 44, "atk": 52, "def": 43, "spd": 65 },
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

Interactions are checked in order; the first one whose `requiresFlag` is satisfied *and* whose `forbidsFlag` is not set runs (`forbidsFlag` makes one-time gifts — e.g. three starter pedestals that all set `starter_chosen`). Commands: `say`, `set_flag`, `win`, `give_species`, `give_item`, `give_money`, `heal_party`, `sell`. Entities can set `"passableWithFlag": "some_flag"` to stop blocking once a flag is set. `validateGame` cross-checks everything against the catalog (encounter species, item/species refs in commands, trainer parties, party members) with errors that name the fix.

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
