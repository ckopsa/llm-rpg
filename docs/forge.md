# The Forge — authoring games through MCP

The Forge is the LLM-facing authoring interface: an MCP server whose tools edit
one `games/<dir>/game.json` at a time. Every accepted edit is written to disk
immediately (atomic write, undo history); every response tells you what to fix
next. Start it with `npm run forge` (see the README for the `claude mcp add`
line) and follow the loop below.

## The workflow

1. **`forge_new_game`** from the `starter` template (a complete, winnable
   2-map teaching game) and edit it into your game, or from `blank` if you
   want to build every piece yourself. `forge_open` switches between games;
   `forge_overview` re-orients you at any time. Building a story-first game
   with no battles? Make `removeCatalog` your first edit — see
   [Authoring narrative games](#authoring-narrative-games).
2. **Sketch maps outward from the start.** Build the starting map first
   (`createMap`, `paintRect` for borders and areas, `paintCells` for details),
   place its entities, then grow the world one connected map at a time.
3. **Link portals as you go.** A one-way portal to a not-yet-created map is a
   normal draft state — advisory validation keeps flagging it until the map
   exists, and that's your to-do list, not an error to fear.
   `bidirectional: true` is stricter: it writes the RETURN portal too, so the
   destination map must already exist. Two working orders:
   - *Within one batch*: `createMap` the destination earlier in the same
     batch, then `linkPortal` bidirectional — ops apply in order.
   - *Across batches*: link one-way while drafting; once the destination map
     exists, re-run the same `linkPortal` with `bidirectional: true` (portals
     replace per source tile, so re-linking is idempotent).
4. **Catalog before encounters.** `setTypeChart`, `addMove`, `addSpecies`,
   `addItem` must come before anything that references them: encounter
   tables, trainer parties, `give_species`/`give_item` commands all validate
   against the catalog.
5. **`forge_check` after every connectivity change** — map paints, portals,
   blocking entities, `passableWithFlag` edits, triggers that teleport. It is
   a millisecond static BFS; an unreachable map or orphan portal caught now
   is minutes saved later. Read its `limitations` list — it tells you
   honestly what the static pass cannot see (see the narrative chapter).
6. **`forge_playtest` explore before adding trainers.** The explorer proves
   the world graph and quest flags work end to end. Add battles and tuning
   only once exploration wins. For a catalog-free narrative game the success
   signal is `completed: true` (any ending reached, `stopReason: "ended"`);
   for catalog games it stays `win`.
7. **Script playtest for the golden path.** When the game is done, record the
   intended winning action list with `forge_playtest` script mode. It is your
   regression test: rerun it after every balance change (same seed, same
   result — the sim is deterministic).
8. Made an accepted edit you regret? **`forge_undo`** (up to 50 steps).
   Rejected ops never need undoing — they write nothing, and the response
   shows the current on-disk state so you always know what's real.

## Op reference

Used through `forge_edit { op, args }` or `forge_batch { ops }` (a batch is
all-or-nothing and one undo step — ideal for building a whole map).

| Op | Args | Notes |
|---|---|---|
| `createGame` | `id, title, goal` | Replaces the whole document — new drafts only |
| `setMeta` | `id?, title?, goal?, version?` | Shallow-merge; omitted fields keep their values |
| `createMap` | `mapId, width, height, fill` | No auto-border: paint edges with `#` yourself |
| `paintRect` | `mapId, x1, y1, x2, y2, char` | Inclusive rectangle, any corner order |
| `paintCells` | `mapId, cells: [{x, y, char}]` | All-or-nothing cell list |
| `addTile` / `removeTile` | `char, tile` / `char` | Remove refuses while any map still paints the char |
| `placeEntity` | `mapId, entity` | Entity ids are unique game-wide; the entity may carry `interactions`, a `trainer` block, `sprite`, `variants` |
| `updateEntity` | `entityId, patch` | `patch.mapId` moves it; `patch.id` renames it |
| `removeEntity` | `entityId` | Refuses while commands still reference the entity |
| `setDialogue` | `entityId, interactions` | Replaces the whole interactions array (`[]` clears) |
| `setTriggers` | `mapId, triggers` | Replaces the map's triggers array (`[]` clears) |
| `addTrigger` / `removeTrigger` | `mapId, trigger` / `mapId, triggerId` | Trigger ids unique per map |
| `setVariants` | `entityId, variants` | Replaces the entity's variants array (`[]` clears); ids unique per entity |
| `linkPortal` | `from: {mapId,x,y}, to: {mapId,x,y}, bidirectional?` | One portal per tile; one-way to a missing map is fine, bidirectional needs the map to exist (see workflow step 3) |
| `setEncounters` | `mapId, zone \| null` | `{rate, table: [{speciesId, minLevel, maxLevel, weight}]}` |
| `setPlayerStart` | `mapId, x, y, party?, money?, inventory?, respawn?, glyph?` | Omitted fields keep their values |
| `addSpecies` / `updateSpecies` / `removeSpecies` | `species` / `speciesId, patch` / `speciesId` | Remove refuses while referenced |
| `addMove` / `updateMove` / `removeMove` | `move` / `moveId, patch` / `moveId` | Status moves: power 0 + an `effect` |
| `addItem` / `updateItem` / `removeItem` | `item` / `itemId, patch` / `itemId` | `heal` needs `amount`; `capture` needs `ballMod` |
| `setTypeChart` | `types, effectiveness` | Partial coverage: missing pairs default to 1.0 |
| `removeCatalog` | *(none)* | Deletes an EMPTY catalog → catalog-free narrative game; refuses while moves/species/items remain |

## Field schemas

The minimal shape of every object the ops take. Optional fields marked `?`;
everything else is required. Rejections name the missing field, but writing it
right the first time is cheaper.

- **tile** (`addTile`): `{ name, glyph, walkable, wild? }` — `wild: true`
  makes it an encounter tile (default false).
- **species** (`addSpecies`): `{ id, name, glyph, types: [1..2 type names],
  baseStats: { hp, atk, def, spd }, learnset: [{ level, moveId }] (min 1,
  include a level-1 move), catchRate (0..1), xpYield, evolvesTo?: { speciesId,
  level } }`.
- **move** (`addMove`): `{ id, name, type, power, accuracy (0..1), pp,
  category? ("physical" | "special" | "status", default physical),
  effect?: { kind: "raise_atk" | "raise_def" | "raise_spd" | "lower_atk" |
  "lower_def" | "lower_spd" } }` — status moves need `power: 0` and an effect.
- **item** (`addItem`): `{ id, name, kind: "heal" | "capture",
  amount? (heal), ballMod? (capture), price? }`.
- **entity** (`placeEntity`): `{ id, name, glyph, x, y, blocking? (default
  true), passableWithFlag?, interactions? (default []), trainer?, sprite?,
  variants? }`.
- **interaction**: `{ commands: [command, ...] (min 1), requiresFlag?,
  forbidsFlag?, when? }` — the first interaction whose gates all pass runs.
- **trainer** (on an entity): `{ party: [{ speciesId, level }] (1..6),
  defeatFlag, lineOfSight?: { dir, range }, rewardMoney?, rewardCommands?,
  intro?, defeatText?, outro? }`.
- **trigger** (`addTrigger`/`setTriggers`): `{ id, on: "enter" | "step",
  tiles?: [{ x, y }] (required for step, invalid for enter), once? (default
  true), when?, commands (min 1) }`.
- **variant** (`setVariants`): `{ id, when?, glyph?, sprite?, name? }` — the
  first variant whose `when` passes wins; omitted fields fall back to the
  base entity.
- **command**: `{ type, ...fields, when? }` — the full command set (say,
  set_flag, set_var, add_var, passage, choice, give_species, give_item,
  give_money, heal_party, sell, win, end, teleport_player, show_title,
  move_entity, spawn_entity, remove_entity, set_tile, set_variant, wait,
  camera_focus, play_music, screen_effect) is documented field-by-field in
  the README's "Game format in 30 seconds".

## Schema conventions

**Legend chars.** Keep the shared vocabulary boring and consistent: `#` tree /
wall (not walkable), `.` grass, `,` road, `~` water, `*` tall grass
(`"wild": true` — the only thing that triggers encounters). Both templates
ship all five. Add new chars (`addTile`) for interiors (`=` floor, `%` wall)
rather than reusing outdoor ones. Any map with a wild tile **must** have an
`encounters` zone.

**Flag gating.** Flags are the whole quest system. The three patterns:

- *Gatekeeper*: a blocking entity with `"passableWithFlag": "some_flag"` stops
  blocking once the flag is set (Guard Bram). Put its interactions in order:
  gated (`requiresFlag`) lines first, ungated fallback last.
- *One-time gift*: `"forbidsFlag": "starter_chosen"` on an interaction that
  ends with `set_flag starter_chosen` — runs once, silently skipped after.
  Three pedestals all checking the same flag = a starter choice.
- *Sequential chain*: badge gates are just gatekeepers in series — keeper A's
  `rewardCommands` set `badge_a`, the pass to region B requires it
  (`passableWithFlag: "badge_a"`), and so on to the finale. `forge_check`'s
  pessimistic pass shows exactly which content each gate closes — expected
  for badge gates, alarming for your starter town.

**Spatial menus.** There is no menu UI: shops and choices between *things* are
*places*. One counter/pedestal entity per item or option, each with a `sell`
command or a flag-gated gift. A heal point is an entity with `heal_party`
(make it free and put one in every town). Choices between *answers* are the
`choice` command — see the narrative chapter. `win` (or an ungated `end`)
must be the last command of its list, on an NPC gated by the final flag.

## Authoring narrative games

A narrative game is a story you walk through: no catalog, no battles, no
inventory — dialogue, choices, cutscenes, and endings carry everything. The
engine treats "no `catalog` key" as the narrative signal, and validation then
errors (naming the fix) on anything battle-bound: wild tiles, encounter
zones, trainer blocks, `give_species`/`give_item`/`sell`, non-empty starting
party/inventory.

**Why there is no "empty catalog".** An empty catalog object
(`{ typeChart: { types: [] }, ... }`) is deliberately invalid — it almost
always means an unfinished battle game, and validation should keep saying so.
*Absence* of the key is the explicit, deliberate narrative signal, and
`removeCatalog` (which refuses while moves/species/items remain) is the
one-op way to get there.

### Setup

```
forge_new_game { dirName, id, title, goal, template: "blank" }
forge_edit { op: "removeCatalog", args: {} }
```

From there the draft validates as soon as it has one map and a player start —
valid-by-construction is one batch away. `forge_overview` will say
`catalog-free NARRATIVE game` and report trigger/variant/ending counts.

### Act structure: triggers + show_title

Acts are maps (or regions of one map); act breaks are triggers. The skeleton:

- An `enter` trigger on the start map is your cold open — it fires at game
  start, before the first action: `show_title` for the act card, a `passage`
  to set the scene, `play_music` for the renderer.
- `step` triggers on doorways and thresholds advance the story mid-act
  (`tiles` lists the threshold tiles; `once: true` is the default and almost
  always right; a failing `when` leaves the trigger unfired for later).
- A `teleport_player` at the end of an act's trigger jumps to the next act's
  map and fires ITS `enter` trigger — chain them and the acts sequence
  themselves. Destinations are statically validated, and `forge_check`
  follows teleports as reachability edges, so a map connected only by
  teleport is still analyzed (the report's `teleports` list shows every edge).

Pace inside a trigger with `wait { beats }` between story beats, and
`screen_effect` / `camera_focus` for emphasis. Text observers narrate the
same sequence as ordered events; the web renderer paces it from cues.

### The observed-scene pattern (the heavenly court)

A cutscene may play on a map the player never visits — overlays are
map-scoped and `camera_focus` accepts entities and tiles anywhere:

```jsonc
{ "id": "court-scene", "on": "step", "tiles": [{ "x": 4, "y": 2 }],
  "commands": [
    { "type": "show_title", "text": "Meanwhile", "subtitle": "In the court above" },
    { "type": "camera_focus", "entityId": "accuser" },
    { "type": "passage", "lines": ["Whence comest thou?"], "citation": "Job 1:7" },
    { "type": "move_entity", "entityId": "accuser", "path": ["east", "east"] },
    { "type": "set_flag", "flag": "wager_struck" },
    { "type": "camera_focus", "release": true }
] }
```

The player never moves; the court map's overlays persist (the accuser stays
where the scene left him). Build the off-stage map like any other — it just
never needs a portal.

### Choice trees, vars, and axes

`choice` puts a real decision in a dialogue; `set_var`/`add_var` make the
decisions accumulate. The conventions that keep a tree manageable:

- **Flags for events, vars for axes.** `set_flag wager_struck` records that a
  thing happened; `add_var candor 1` / `add_var candor -1` records *how* the
  player keeps answering. Late-game gates then read the axis:
  `{ "var": "candor", "op": "gte", "value": 2 }`.
- **Branch shallow, reconverge fast.** Put consequences in flags/vars, not in
  parallel copies of the story. A choice's option should usually be 1-3
  commands (a say, a set_flag/add_var) — the shared script after the choice
  resumes automatically (`say → choice → say-epilogue` runs in that order).
- **Always leave an ungated option.** Options whose `when` fails are hidden;
  a choice with zero open options is skipped with an explanatory event, and
  validation warns when every option is gated. The ungated last option is
  your guaranteed fallback.
- **Nested choices work** (an option may contain another `choice`) but two
  levels is usually the readable limit — deeper trees are better modeled as
  repeat visits gated on flags.
- **Re-interview pattern**: an NPC whose first interaction is
  `when`-gated on the flag the choice sets — choose, then talk again and the
  conversation has moved on. This is how a small cast carries a long story.

### Passages and tone

`passage { title?, lines[], citation? }` is for text that deserves shape:
poetry, scripture, letters, narration. Observers render it in full, never
truncated, so the text carries the weight — use it for the moments that
matter and keep `say` for talk. Trigger-sourced `say` lines print bare
(narrator voice); entity-sourced lines print with the speaker's name — and
the speaker's name follows variants, so a `set_variant` mid-scene changes who
appears to be talking.

### Variants

`variants` on an entity are conditional appearances — before/after states
driven by the same flags and vars as everything else:

```jsonc
"variants": [
  { "id": "afflicted", "when": { "flag": "boils" }, "glyph": "j", "name": "Job the Afflicted" },
  { "id": "restored",  "when": { "var": "fortune", "op": "gte", "value": 2 }, "name": "Job the Restored" }
]
```

First `when`-match wins; base fields are the fallback; `set_variant` forces
one from a cutscene until cleared. Manage them with `setVariants`.

### Endings

`end { id, text }` finishes the game with a named ending; `win { text }` is
sugar for `end { id: "victory" }` and is the only ending that counts as
*winning*. Design notes:

- Multiple endings are cheap: gate each `end` behind its flags/vars/axis
  thresholds. `validateGame` returns every ending id; `forge_overview` lists
  them; playtest reports carry the `ending` reached.
- An ungated `end` must be the last command of its list; `when`-gated ends
  may sit mid-list (first one whose gate passes fires).
- Order ending interactions like gated dialogue: the most specific
  (hardest-gated) ending first, the fallback ending last.

### Testing a narrative game

`forge_check` follows teleport edges and reports `limitations` honestly: the
static pass does NOT simulate runtime overlays (`set_tile` walls,
`spawn_entity` blockers, `remove_entity` openings), so a cutscene that opens
or closes a path is invisible to it. The dynamic check is `forge_playtest`
explore: the explorer targets unfired step-trigger tiles, resolves choices
deterministically (first option, then the next after 3 identical
presentations), and for a narrative game its success signal is
`completed: true` / `stopReason: "ended"` — reaching ANY ending is a
completed story (`win` keeps meaning the "victory" ending). If it stops
`exhausted`, the stopDetail names the closed gates it knows about.

## Pacing and tuning (learned from Emberwood)

- **Level curve**: starter at 5-7; wild kindred ~2-3 levels under the player's
  expected level in that area; route trainers at the player's level with 1-2
  kindred; keepers (bosses) +2-3 levels with themed parties (Fern 12-14,
  Bram 16-18, finale 20-22 in Emberwood's ~7-map arc). Scale down
  proportionally for shorter games.
- **Evolution as payoff**: put the starter's evolution level (~14-16) where
  the mid-game difficulty spike is, and make sure the mandatory-path XP gets
  the player there without grinding — XP per faint is
  `floor(xpYield * enemyLevel / 5)` against a cubic (`L^3`) level curve.
- **Catch economics**: commons 0.5-0.6 catchRate, uncommons 0.35-0.45, rares
  ~0.2; snares priced so the player can afford 2 snares + 1 salve after the
  first trainer win (trainer `rewardMoney` ≈ 2x a snare's price). The catch
  roll is `clamp(catchRate * ballMod * (1.3 - hp/maxHp), 0.05, 0.95)` —
  weakening matters, so give wilds enough HP to survive one hit.
- **Encounter rate** 0.15-0.25; make the road through a route grass-free so
  crossing is a choice, and keep required backtracking short.
- **Gate on the harness**: the explorer (`forge_playtest` explore) should win
  a finished game — it fights greedily and never grinds, so if it can't win,
  a player has to grind. Emberwood's rule of thumb: winnable in < 2000 steps.
  A lost fight is diagnosable from the report's `battleDetails` (opponent,
  enemy party, steps, result, party HP after) plus a widened `tail`.

## Tone

- **Two sentences, maximum, per `say`.** If a line needs three, it's two NPCs
  or a sign plus an NPC — or a `passage`, if the words deserve the room.
- **Specifics over lore.** A cold kettle, a quiet beehive, a dog barking at
  geysers — never paragraphs of world history. The mystery ("the Hush is
  described, never explained") does more work than the explanation.
- NPCs talk like small-town neighbors: practical, a little superstitious,
  fond of their creatures. Nobody says "quest".
- Name things so the JSON documents itself: `elder-wren`, `trail_brazier_lit`,
  `warm-salve` — ids are the only comments JSON gets.
- Villains are people with reasons. The best final boss is out-argued, not
  destroyed; write `defeatText` accordingly.
