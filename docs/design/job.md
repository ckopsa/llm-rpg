# THE TRIAL OF JOB — Design Bible

*A narrative game from the Book of Job. No battles. No catalog. The engine's
first scripture.*

## Source and fidelity

Text: the **World English Bible (WEB)** — public domain, modern English.
Rules of engagement with the source:

1. **Quotation is sacred.** `passage` commands carry real WEB text, 4–10
   lines, always with a citation ("— Job 38:4–7, WEB"). Dialogue may
   paraphrase, but paraphrase never wears a citation.
2. **Canonical beats stay canonical.** The player's choices control *tone,
   emphasis, and pacing* inside the text's latitude — never the record.
   Job tears his robe; Job speaks first after the seven days; Job never
   answers Elihu; God answers from the whirlwind, not with reasons.
3. **The design thesis comes from 42:7.** God says the *friends* did not
   speak rightly, and Job — the protester, the accuser of heaven — did.
   So the game's central mechanic is **candor**: at every dialogue beat the
   player may answer with Job's honest protest or with the friends' pious
   formulas. Honesty is the narrow road. Piety-as-performance is the trap.
4. **Reverence in depiction.** God is never a sprite: the whirlwind is
   weather, light, and words (screen effects + passages). The Accuser in
   the court scene is a dim figure, not a horned devil. The children's
   deaths are reported by messengers, as in the text — never shown.

## Tone

Spare and unhurried. Long silences that cost the player real inputs.
The message box carries small human things (a cold hearth, a dog that
stopped barking); the passage pane carries the poetry and is never rushed.
Wait beats are load-bearing: this game is slow on purpose.

## The candor variable

`candor: 0–6`, incremented at the six response beats (three friends ×
two rounds). It is invisible to the player (no HUD; conscience is not a
meter). It gates the whirlwind's address and the ending.

## Structure (acts, maps, mechanics)

**Act I — The Land of Uz** (`uz-estate`, `feast-house` interior)
Job's household whole: seven sons and three daughters (the eldest's feast
house is enterable), flocks (7,000 sheep as herds of entities, not a
census), servants with small warm lines. The ritual loop that teaches
interaction: rise, walk to the altar, offer for each child ("It may be
that my sons have sinned" — Job 1:5). A step trigger on leaving the altar
the final time starts the interlude.

**Interlude — The Court of Heaven** (`heaven-court`, observed scene)
`show_title` ("On a day when the sons of God came") → `camera_focus` onto
a map the player never walks → the Accuser's challenge as passage (Job
1:6–12) → release. The player now knows what Job never will. This is the
whole reason the observed-scene machinery exists. *Note: the reachability
analyzer will flag `heaven-court` as unreachable — that is correct and
accepted; record the exception in the game README.*

**Act II — The Day of Calamity** (uz-estate, cutscene)
Four messengers: each spawns at the road and hurries to Job, and each
begins "While he was yet speaking" — `spawn_entity`, `move_entity`, no
music, one `screen_effect` flash for the fire of God, wind `shake` for
the house. Then the mourning interactions in Job's own order: tear robe,
shave head, fall to the ground — and the fixed word: "Yahweh gave, and
Yahweh has taken away. Blessed be Yahweh's name." (1:21, passage). This
is not a choice. It is who Job is.

**Act III — The Ash Heap** (`ash-heap`; Job's **variant** swaps to the
afflicted sprite; the estate retiles gray behind him via `set_tile`)
The wife's scene, the game's first true choice:
- *"You still hold to your integrity?"* → hold fast (canonical path), or
- accept "curse God and die" → early quiet ending **`the-story-untold`**:
  the screen dims, one line — "The scroll goes on without this page." —
  and return to title. Gentle. No punishment depicted.

Then the friends arrive and the **seven days of silence**: Eliphaz,
Bildad, and Zophar sit as entities; a mat beside them. Sitting (interact)
advances `days_of_silence` by one — seven deliberate, repeated inputs,
each answered only by a two-line atmospheric fragment (the wind, the
potsherd, the stars coming out) and a slow dimming. No one speaks until
Job does: on the seventh sit, Job's lament (Job 3 excerpts) as passage,
and the cycles begin.

**Act IV — The Cycles** (ash-heap)
Six beats: Eliphaz → response, Bildad → response, Zophar → response,
twice around, compressed. Each friend speaks real excerpts (their best
arguments — they must be *persuasive*, that's the point). Each response
is a three-way choice:
- **Honest protest** (Job's actual words: 6–7, 9–10, 13, 19, 21) → candor +1
- **Their formula back** ("Surely I have sinned; I will be silent") → candor +0
- **Silence** → candor +0, but the friends press harder next round
The "I know that my Redeemer lives" beat (19:25) fires on the honest path
in round two — the game's still center. Then Elihu speaks (passage
interlude, 32–33 excerpts) and — canonically — Job does not answer him.
The storm begins while Elihu is still talking (37: "out of the north
comes golden splendor").

**Act V — The Whirlwind** (`whirlwind-*`: five small vista maps chained
by `teleport_player`; `play_music` switches to a storm track; fade
between)
God answers with geography. Each vista holds one waystone and one
passage of real questions:
1. *The Foundations* (38:4–7 — "when the morning stars sang together")
2. *The Sea's Doors* (38:8–11 — "here your proud waves shall be stayed")
3. *The Storehouses* (38:22–30 — snow, hail, the ice)
4. *The Wild Places* (39 — ostrich, warhorse, hawk; the creatures that
   owe us nothing)
5. *Behemoth and Leviathan* (40:15–, 41 — rendered as vast still shapes
   at the map's edge, mostly out of frame)
At the last waystone, the confrontation. If **candor ≥ 4**: the choice is
Job's — attempt an answer (the storm gently asks again; attempting is
never punished, it simply cannot end the storm) or **"I lay my hand on my
mouth"** (40:4) → then 42:5–6 as passage → Act VI. If **candor < 4**: the
whirlwind's words land differently — "Who is this who darkens counsel by
words without knowledge?" addressed to a Job who spent the cycles
reciting borrowed theology — ending **`not-spoken-rightly`** (42:7
inverted, quiet, unrestored). The thesis, mechanized: only the honest
path can even *hear* the answer.

**Act VI — The Latter Days** (`uz-restored`)
Job prays for each friend by name (three interactions — the text's
condition for their pardon). Restoration as cutscene: flocks doubled
(spawns), the estate retiled whole, and the three daughters — **Jemimah,
Keziah, Keren-happuch** — named as entities, "and their father gave them
an inheritance among their brothers" (42:15). Ending **`victory`**:
"After this, Job lived one hundred forty years, and saw his sons, and
his sons' sons, to four generations." No triumphal music. The town theme,
warm, at last.

## Endings

| id | path | tone |
|---|---|---|
| `victory` | candor ≥ 4, hand on mouth, friends prayed for | restoration, quiet joy |
| `not-spoken-rightly` | candor < 4 at the whirlwind | the rebuke of 42:7, unrestored |
| `the-story-untold` | accept the wife's counsel | dim, gentle, a page unwritten |

## Production notes

- **Catalog-free** (`catalog` omitted). No battles, no party, no shops.
  Money unused.
- **Art within the current tileset**: Uz is pastoral (grass/path/house);
  ash and ruin via sand/cliff tiles and `set_tile` graying; whirlwind
  vistas abstract (water, cliff, cave tiles; emoji fallback where the
  tileset runs out is acceptable and honest). File a follow-up bead for a
  weather/palette overlay rather than fighting the tileset.
- **Playtest gates**: explorer must reach *some* ending (< 1,500 steps);
  a scripted golden path must reach `victory`; forge_check pass with the
  documented `heaven-court` exception.
- **Dialogue discipline**: NPC chatter ≤ 2 sentences; the friends'
  arguments live in passages, the human moments in chatter.
- Author with the Forge. This game is the acceptance test for the
  narrative epic (bead llm-rpg-djt.9) — every rough edge found while
  building it gets a bead.
