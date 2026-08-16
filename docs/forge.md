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
   `forge_overview` re-orients you at any time.
2. **Sketch maps outward from the start.** Build the starting map first
   (`createMap`, `paintRect` for borders and areas, `paintCells` for details),
   place its entities, then grow the world one connected map at a time.
3. **Link portals as you go** (`linkPortal`, usually `bidirectional: true`).
   A portal to a not-yet-created map is a normal draft state — advisory
   validation keeps flagging it until the map exists, and that's your to-do
   list, not an error to fear.
4. **Catalog before encounters.** `setTypeChart`, `addMove`, `addSpecies`,
   `addItem` must come before anything that references them: encounter
   tables, trainer parties, `give_species`/`give_item` commands all validate
   against the catalog.
5. **`forge_check` after every connectivity change** — map paints, portals,
   blocking entities, `passableWithFlag` edits. It is a millisecond static
   BFS; an unreachable map or orphan portal caught now is minutes saved later.
6. **`forge_playtest` explore before adding trainers.** The explorer proves
   the world graph and quest flags work end to end. Add battles and tuning
   only once exploration wins.
7. **Script playtest for the golden path.** When the game is done, record the
   intended winning action list with `forge_playtest` script mode. It is your
   regression test: rerun it after every balance change (same seed, same
   result — the sim is deterministic).
8. Made an accepted edit you regret? **`forge_undo`** (up to 50 steps).
   Rejected ops never need undoing — they write nothing.

## Op reference

Used through `forge_edit { op, args }` or `forge_batch { ops }` (a batch is
all-or-nothing and one undo step — ideal for building a whole map).

| Op | Args | Notes |
|---|---|---|
| `createGame` | `id, title, goal` | Replaces the whole document — new drafts only |
| `createMap` | `mapId, width, height, fill` | No auto-border: paint edges with `#` yourself |
| `paintRect` | `mapId, x1, y1, x2, y2, char` | Inclusive rectangle, any corner order |
| `paintCells` | `mapId, cells: [{x, y, char}]` | All-or-nothing cell list |
| `addTile` / `removeTile` | `char, tile` / `char` | Remove refuses while any map still paints the char |
| `placeEntity` | `mapId, entity` | Entity ids are unique game-wide |
| `updateEntity` | `entityId, patch` | `patch.mapId` moves it; `patch.id` renames it |
| `removeEntity` | `entityId` | |
| `setDialogue` | `entityId, interactions` | Replaces the whole interactions array |
| `linkPortal` | `from: {mapId,x,y}, to: {mapId,x,y}, bidirectional?` | One portal per tile; dangling `to` map allowed |
| `setEncounters` | `mapId, zone \| null` | `{rate, table: [{speciesId, minLevel, maxLevel, weight}]}` |
| `setPlayerStart` | `mapId, x, y, party?, money?, inventory?, respawn?, glyph?` | Omitted fields keep their values |
| `addSpecies` / `updateSpecies` / `removeSpecies` | `species` / `speciesId, patch` / `speciesId` | Remove refuses while referenced |
| `addMove` / `updateMove` / `removeMove` | `move` / `moveId, patch` / `moveId` | Status moves: power 0 + an `effect` |
| `addItem` / `updateItem` / `removeItem` | `item` / `itemId, patch` / `itemId` | `heal` needs `amount`; `capture` needs `ballMod` |
| `setTypeChart` | `types, effectiveness` | Partial coverage: missing pairs default to 1.0 |

## Schema conventions

**Legend chars.** Keep the shared vocabulary boring and consistent: `#` tree /
wall (not walkable), `.` grass, `,` road, `~` water, `*` tall grass
(`"wild": true` — the only thing that triggers encounters). Add new chars
(`addTile`) for interiors (`=` floor, `%` wall) rather than reusing outdoor
ones. Any map with a wild tile **must** have an `encounters` zone.

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

**Spatial menus.** There is no menu UI: shops and choices are *places*. One
counter/pedestal entity per item or option, each with a `sell` command or a
flag-gated gift. A heal point is an entity with `heal_party` (make it free and
put one in every town). `win` must be the last command of its list, on an NPC
gated by the final flag.

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

## Tone

- **Two sentences, maximum, per `say`.** If a line needs three, it's two NPCs
  or a sign plus an NPC.
- **Specifics over lore.** A cold kettle, a quiet beehive, a dog barking at
  geysers — never paragraphs of world history. The mystery ("the Hush is
  described, never explained") does more work than the explanation.
- NPCs talk like small-town neighbors: practical, a little superstitious,
  fond of their creatures. Nobody says "quest".
- Name things so the JSON documents itself: `elder-wren`, `trail_brazier_lit`,
  `warm-salve` — ids are the only comments JSON gets.
- Villains are people with reasons. The best final boss is out-argued, not
  destroyed; write `defeatText` accordingly.
