# The Trial of Job

A narrative game from the Book of Job. No catalog, no battles, no money, no
party — dialogue, choices, cutscenes, silence, and three endings. The design
bible is `docs/design/job.md`; the scripture is the **World English Bible**
(public domain), quoted verbatim and always cited.

Authored end to end through the Forge MCP server (`npm run forge`, driven by a
Node stdio client) — `game.json` was never hand-edited. `sprites.json` is
hand-written; the Forge has no sprites tool yet (llm-rpg-85g.9).

**The thesis is Job 42:7.** God says the *friends* did not speak rightly and
Job — who protested, accused, and demanded an answer — did. So the mechanic is
**candor**: at each of the six dialogue beats you may answer with Job's own
words, hand the friends their formula back, or say nothing. Only honesty can
hear the whirlwind out.

## Content inventory

| Act | Map(s) | Entities | Triggers |
|---|---|---|---|
| I — The Land of Uz | `uz-estate` (16×12), `feast-house` (9×7) | altar, wife, shepherd boy, plowman, sheep, camels, oxen, courtyard dust; eldest son, daughter, feast table | `act-one-open` (enter, cold open), `court-of-heaven` (step, after the third offering) |
| Interlude — the court above | `heaven-court` (9×7, never walked) | The Accuser, The Sons of God, `job-seen` (variants: afflicted / restored) | — (played by `camera_focus` from the other maps) |
| II — The Day of Calamity | `uz-estate` | four messengers, spawned and moved | `day-of-calamity` (step, road tiles, gated on `wager_struck`) |
| III/IV — The Ash Heap & The Cycles | `ash-heap` (14×10) | wife, the ash heap itself, Eliphaz, Bildad, Zophar (variant: named on arrival), Elihu (variant: named at `round_two`) | `act-three-open` (enter), `friends-arrive` (step, gated on `held_integrity`) |
| V — The Whirlwind | `whirlwind-foundations`, `-sea`, `-storehouses`, `-wild`, `-leviathan` (9×7 each) | five waystones; ostrich, horse, hawk; Behemoth, Leviathan | one `enter` trigger each (title card, weather, music) |
| VI — The Latter Days | `uz-restored` (14×10) | Eliphaz, Bildad, Zophar (to be prayed for), the gate of the yard; flocks and Jemimah / Keziah / Keren Happuch spawn in the restoration cutscene | `act-six-open` (enter, Job 42:7–8), `restoration` (step, gated on `friends_pardoned`) |

10 maps · 34 placed entities · 12 triggers · 5 entities with variants ·
**63 cited scripture passages** and 52 uncited narration passages · 3 endings.

Cutscene vocabulary used: `spawn_entity`, `move_entity`, `set_tile`,
`set_variant` (both forms), `camera_focus` (entity, tile, release), `wait`,
`screen_effect` (flash / shake / fade), `play_music`, `show_title`,
`teleport_player`, `passage`, `choice`, `end` / `win`.

## The candor beats

`candor` is invisible to the player — no HUD; conscience is not a meter. Six
beats, +1 each for the honest answer, 0 for the friends' formula and 0 for
silence (silence also sets `pressed_harder`, and the friends lean on you
harder next round). The whirlwind's final waystone opens the choice at
**candor ≥ 4**; below that it delivers the rebuke.

| # | Speaker | Their argument | Honest answer (+1) | Formula (0) | Silence (0) |
|---|---|---|---|---|---|
| 1 | Eliphaz I | Job 4:7–9, 5:17–19 | Job 6:2–4, 7:11 | "I will not despise the chastening" | — |
| 2 | Bildad I | Job 8:3–7 | Job 9:20–24, 9:32–33 | "If my children sinned…" | — |
| 3 | Zophar I | Job 11:5–6, 11:13–16 | Job 13:3–5, 13:15 | "I will put iniquity far away" | — |
| 4 | Eliphaz II | Job 15:4–6, 15:20–22 | Job 16:2–5 | "My own mouth condemns me" | — |
| 5 | Bildad II | Job 18:5–8, 18:14 | **Job 19:23–27** — the Redeemer | "The lamp of the wicked is put out" | — |
| 6 | Zophar II | Job 20:4–8 | Job 21:7–13 | "The triumphing of the wicked is short" | — |

Job never answers Elihu (Job 32–33, 37): his interaction has no `choice`, and
the storm rises while he is still speaking.

## Endings

| id | how | verified script |
|---|---|---|
| `victory` | candor ≥ 4 → "I lay my hand on my mouth" → pray for the three friends → the gate | golden path below, 107 turns |
| `not-spoken-rightly` | candor < 4 at the last waystone | golden path with `choose2` at all six cycle beats, and no `choose1` after the final `interact` |
| `the-story-untold` | take the wife's counsel at the ash heap | 21 turns, below |

The sim has no RNG (no catalog, no battles), so every run is identical; the
CLI's default seed 1 is used throughout.

### Golden path — `victory` (107 turns)

```
npm run play -- --game games/trial-of-job/game.json --actions "<the list below>"
```

```
# Act I: east to the altar path, up to the altar, three offerings
east north north north
interact interact interact
# step away from the altar — the court of heaven
south
# down to the road and east until the messengers come
south south east east east east
# the courtyard dust: tear the robe, shave the head, fall down (→ ash heap)
interact interact interact
# the ash heap: up to your wife, hold your integrity
north north interact choose1
# east to the friends, then sit — seven days of silence
east east east east east north
interact interact interact interact interact interact interact
# cycle one: Eliphaz, Bildad, Zophar — honest answer each time
east north north interact choose1
south east east south south interact choose1
south interact choose1
# cycle two: Eliphaz, Bildad (the Redeemer), Zophar
north north north west interact choose1
east south south interact choose1
south interact choose1
# Elihu speaks; the storm takes you mid-sentence
south east east interact
# the whirlwind: five waystones
north north interact
north north interact
north north interact
north north interact
north interact choose1
# Act VI: pray for Eliphaz, Bildad, Zophar
north north north north north interact
south east east east east interact
east east east interact
# walk into the yard — restoration — then stand in the gate
south west south south
east east east east interact
```

One line, as the CLI wants it:

```
east,north,north,north,interact,interact,interact,south,south,south,east,east,east,east,interact,interact,interact,north,north,interact,choose1,east,east,east,east,east,north,interact,interact,interact,interact,interact,interact,interact,east,north,north,interact,choose1,south,east,east,south,south,interact,choose1,south,interact,choose1,north,north,north,west,interact,choose1,east,south,south,interact,choose1,south,interact,choose1,south,east,east,interact,north,north,interact,north,north,interact,north,north,interact,north,north,interact,north,interact,choose1,north,north,north,north,north,interact,south,east,east,east,east,interact,east,east,east,interact,south,west,south,south,east,east,east,east,interact
```

### `the-story-untold` (21 turns)

```
east,north,north,north,interact,interact,interact,south,south,south,east,east,east,east,interact,interact,interact,north,north,interact,choose2
```

### `not-spoken-rightly`

The golden path with `choose2` (the friends' formula) at each of the six cycle
beats, and the last waystone reached with a bare `interact` — with candor below
4 there is no choice to make there:

```
east,north,north,north,interact,interact,interact,south,south,south,east,east,east,east,interact,interact,interact,north,north,interact,choose1,east,east,east,east,east,north,interact,interact,interact,interact,interact,interact,interact,east,north,north,interact,choose2,south,east,east,south,south,interact,choose2,south,interact,choose2,north,north,north,west,interact,choose2,east,south,south,interact,choose2,south,interact,choose2,south,east,east,interact,north,north,interact,north,north,interact,north,north,interact,north,north,interact,north,interact
```

## Validation and playtest status

- `npm run validate -- games/trial-of-job/game.json` — **valid, 0 errors, 0 warnings**.
- `forge_playtest` explore (maxSteps 1500, seed 1) — **win, ending `victory`,
  261 steps**, 26 of 34 entities interacted with, only `heaven-court`
  unvisited.
- `forge_playtest` script (golden path above) — **win, 107 steps**.
- Every quoted line was checked programmatically against the fetched WEB text
  of Job: 197 quoted lines, 0 mismatches, and every line falls inside the
  verse range its citation names.

### Accepted finding: `heaven-court` is unreachable

`forge_check` reports `verdict: "fail"` — 1 unreachable map, 3 unreachable
entities, all of them `heaven-court`. **This is correct and intended.** The
court above is an observed scene: the player never walks there, and the two
court sequences (Job 1:6–12 at the end of Act I, Job 2:1–6 after the mourning)
play through `camera_focus` while Job stands in his own yard, knowing nothing.
The rest of the report is clean — 0 orphan portals, 0 dead wild zones, and all
seven teleport edges resolve. There is currently no way to declare a map
intentionally off-stage; filed as **llm-rpg-v7m**.

## Deviations from the design bible

- **Job's afflicted variant lives on a proxy.** The player *is* Job, and the
  engine has no player variants (`player.glyph` is fixed). The afflicted
  appearance is therefore carried by `job-seen`, the man as the heavenly court
  sees him — forced with `set_variant` at the moment the Accuser is given his
  bone and his flesh, and cleared again at the restoration. Filed as
  **llm-rpg-b6i**.
- **Two court scenes, not one.** The bible specifies the Job 1 court; Job 2:1–6
  is the second wager and the cause of the sores, and it fell naturally out of
  the same machinery, so the mourning sequence ends by cutting back up there.
- **Three offerings, not ten.** The ritual loop is three interactions (sons,
  daughters, "the days you cannot see") rather than one per child; Job 1:4–5,
  quoted at the first offering, carries the "according to the number of them
  all".
- **The friends are placed, not spawned.** The explorer only plans against
  statically placed entities, so Eliphaz, Bildad, Zophar and Elihu stand on the
  ash heap from the start, appearing as "A Traveler on the Road" and "A Young
  Man, Waiting" until their arrival flags flip their variants. Only scenery is
  spawned (the four messengers, the restored flocks, the three daughters). See
  **llm-rpg-tyk**.
- **The graying is a separate map, and `set_tile` runs the other way.** The ash
  heap is its own map rather than a repainted estate; `set_tile` is used in Act
  VI instead, turning the ash left in the yard back to grass during the
  restoration cutscene.
- **Passage count is over budget** (63 cited, target 25–40). Two causes: every
  excerpt carries its own exact, contiguous citation instead of a merged loose
  range, and narration spoken by objects (the altar, the ash heap, the
  courtyard dust) has to ride in uncited passages because entity-sourced `say`
  always prints with a speaker name. See **llm-rpg-8i5**.
- **Behemoth and Leviathan are beached.** They were meant to lie in the water
  at the map's edge; entities may not stand on non-walkable tiles, so they sit
  on the sand at the waterline. See **llm-rpg-1a5**.
- **Candor is only half-invisible.** The design calls for no meter; the text
  observer prints every var, so a text-mode player sees `Vars: candor=…`. There
  is no way to mark a var hidden. See **llm-rpg-wc2**.
- **Repeat beats each set a flag.** The seven days of silence, the three
  offerings and the three acts of mourning use `silence_1..7`, `offering_1..3`,
  `mourn_1..3` rather than a counter var, because the explorer's interaction
  key ignores vars. See **llm-rpg-qtc**.

## Art

The CC0 tileset carries pastoral Uz (grass, path, bush, house walls), the ash
heap and whirlwind ground (path, sand, rock, water), and four character
sprites: `player` for Job, `npc1` for his household and the messengers, `elder`
for the three friends and the afflicted Job seen from above, `guard` for the
plowman. Everything the tileset has no art for falls back to the game's emoji
glyph on purpose: 🔥 the altar, 🌫 the courtyard dust, 🪨 the ash heap, 🌪 the
whirlwind waystones, 🦛 and 🐊 at the edge of the storm.

God is never a sprite. The whirlwind is weather, screen effects, and words.
