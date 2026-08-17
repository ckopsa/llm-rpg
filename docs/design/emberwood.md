# EMBERWOOD — Design Bible

*A creature-collection RPG about keeping the fire lit.*

## Premise

The Emberwood valley is warmed by the **Great Hearth**, an old volcano tamed
generations ago into a network of **waystone braziers** that carry its warmth
through the forests. The braziers are going out. Where they fail, the **Hush**
creeps in — a soft, snowless cold that makes creatures curl up, go quiet, and
forget their songs. It isn't evil. It's just *stopping*.

You are the newest apprentice of **Elder Maren**, Keeper of the Kiln. On the
morning the story begins, the last brazier on the Verdant Trail gutters out,
and Maren is too old to climb. She gives you a firebox, one young creature —
a **kindred** — and a job: walk the old Keeper's road, relight the braziers,
and find out why the Hearth is failing.

The answer is **Vespera, the Quiet Warden** — the previous Keeper. She lost
her own kindred to a fever years ago and has decided, with terrible
gentleness, that a world that can't feel is a world that can't grieve. She has
been *banking* the Hearth, coal by coal. She waits at the summit, not as a
villain who must be destroyed, but as a keeper who must be out-argued — in
the only language keepers share: a battle of kindred.

**Winning**: defeat Vespera at Ashen Peak and relight the Great Hearth.
Ending text: the valley waking up loud — birdsong, geyser-hiss, Biscuit the
dog barking at all of it. (Biscuit returns from Ironwood. Biscuit is canon.)

## Tone

Warm melancholy, gentle humor. NPCs talk like people in a small mountain town:
practical, a little superstitious, fond of their creatures. The Hush is
described, never explained. Nobody says "quest". Dialogue is short — two
sentences beats five, and flavor lives in specifics (a cold kettle, a quiet
beehive) rather than lore dumps.

## Region map (7 maps)

```
                    [Ashen Peak Summit]  ← Vespera, the Great Hearth
                          |
                   [Cinder Ascent]       ← route: scree, vents; Keeper Bram
                          |
   [Mistmarsh] ── [Mosshollow Town]      ← shop, heal-hearth, Keeper Fern
       |                  |
  (wet route,      [Verdant Trail]       ← first route, first brazier
   optional-ish)          |
                  [Kilnhearth Village]   ← start: Maren's kiln, starter choice
```

1. **Kilnhearth Village** — start. Maren's kiln-house (starter choice of 3),
   heal-hearth, tutorial signposts, Biscuit.
2. **Verdant Trail** — tall grass, first wild kindred, 2 novice trainers
   ("Trailhands"), the first cold brazier (relight = story flag + free heal).
3. **Mosshollow Town** — shop (embersalve, kindling snares, keepers' charm),
   heal-hearth, **Keeper Fern** (grass specialist, brazier badge #1).
4. **Mistmarsh** — optional-feeling wet route west of Mosshollow: water/grass
   kindred, 1 trainer, a hermit who gives a free Marshwick if your party has
   an open slot and you've relit the Trail brazier.
5. **Cinder Ascent** — scree switchbacks, fire/rock kindred, 2 trainers,
   **Keeper Bram** (rock specialist, brazier badge #2 — yes, Guard Bram from
   Ironwood, promoted; he remembers the elder's blessing bit and is embarrassed).
6. **Ashen Peak Summit** — short cutscene walk, then Vespera (4-kindred party).
   Gate: requires both brazier flags.
7. **Maren's Kiln (interior)** — tiny interior map to prove doors/interiors.

Gating flags: `starter_chosen`, `brazier_trail`, `badge_fern`, `badge_bram`,
`hearth_relit` (win).

## Kindred roster (18 species, 6 types: fire/water/grass/electric/rock/normal)

Starters (from Maren, choose 1 of 3):

| # | Name | Type | Evolves | Notes |
|---|------|------|---------|-------|
| 1 | **Emberling** | fire | →Pyrewyrm @16 | a coal with opinions; tail like a match-head |
| 2 | **Pyrewyrm** | fire | — | a ribbon of living flame; starter payoff |
| 3 | **Puddlit** | water | →Torrentide @16 | a puddle that follows you home |
| 4 | **Torrentide** | water | — | tide in a dog-shaped body |
| 5 | **Sproutle** | grass | →Bramblore @16 | seedling; sleeps in plant pots |
| 6 | **Bramblore** | grass | — | walking hedge, surprisingly fast |

Wild/route:

| # | Name | Type | Evolves | Where |
|---|------|------|---------|-------|
| 7 | **Fuzzle** | normal | — | Verdant Trail; the "first friend" common |
| 8 | **Gustwing** | normal/electric | — | Verdant Trail/Cinder; crackling songbird |
| 9 | **Voltpup** | electric | →Stormhound @18 | Verdant Trail (rare) |
| 10 | **Stormhound** | electric | — | — |
| 11 | **Marshwick** | water/grass | — | Mistmarsh; candle-reed that drinks fog |
| 12 | **Pebblor** | rock | →Boulderon @20 | Cinder Ascent |
| 13 | **Boulderon** | rock | — | — |
| 14 | **Cindertail** | fire/rock | — | Cinder Ascent; salamander of warm gravel |
| 15 | **Hushmoth** | normal | — | appears only near cold braziers; fast, eerie, hard to catch — the Hush made visible |
| 16 | **Ashenmaw** | fire/rock | — | Vespera's ace only; a hearth that learned to walk and chose not to glow |
| 17 | **Flufflehup** | normal/grass | — | Wick's pasture, the shaggy west corner of Mosshollow; ears up, enormous eyes, and a lightning bolt for a tail |
| 18 | **Ocks** | water/electric | — | same patch, rarer and bigger; a storm that grew fur — dark face, bar-slit eyes, layered blue coat |

Stat identity: starters balanced; Fuzzle tanky-cute; Gustwing/Hushmoth fast
and frail; Pebblor line slow walls; Cindertail bulky pivot; Flufflehup light
and bouncy — quick, soft-hitting, the only grass-type you can catch before the
marsh; Ocks the slow wall the electric line never had (every other electric is
fast and frail); Ashenmaw boss-tier bulk + power.

Flufflehup and Ocks live in their own patch inside town rather than on a
route table, and that placement is load-bearing: the verified winning script in
`games/emberwood/README.md` is pinned move-for-move by
`packages/engine/test/emberwood.test.ts`, and adding an entry to any existing
encounter table reweights the wild draw and desyncs the whole run. New wild
kindred either get their own untravelled patch, or they come with a rebuilt
route script.

## Keeper battles (bosses)

- **Keeper Fern** (Mosshollow): Sproutle-line + Marshwick, ~Lv 12-14. Reward:
  `badge_fern`, money, a keepers' charm (catch-rate item).
- **Keeper Bram** (Cinder Ascent): Pebblor line + Cindertail, ~Lv 16-18.
  Reward: `badge_bram`.
- **Vespera** (Summit): Hushmoth, Stormhound, Boulderon, **Ashenmaw** ~Lv 20-22.
  No items mid-battle for her; she fights quietly ("Vespera says nothing.").
  Defeat = `hearth_relit`, ending scene.

Trainers en route (~6 total) use themed 1-2 kindred parties, Lv 6-15.

## Items (initial set)

- **Embersalve** (heal 20 HP), **Great Embersalve** (heal 50), 
- **Kindling Snare** (capture, 1x), **Warm Snare** (capture, 1.5x),
- **Keepers' Charm** (key item: +catch rate passively, from Fern),
- Money from trainer wins; shop in Mosshollow.

## Feature checklist → beads

Engine: multi-map/portals/encounters (aiw.2) · catalogs (aiw.3) · battle
(aiw.4) · wild wiring (aiw.5) · party/catch/XP/evolve (aiw.6) · trainers +
line-of-sight (aiw.7) · items/shops/heal (aiw.8) · save/load (aiw.9) · web
overworld+battle UI (aiw.10) · battle text observer (aiw.11) · **this content**
(aiw.12) · playtest harness (aiw.13) · sprites/renderer (aiw.14).

Content rules for implementers: all dialogue ≤ 2 sentences per line; every
species id above must exist in the game catalog with learnset covering
Lv 1-22; every encounter table references only roster species; the game must
be winnable by the playtest harness in under 2000 steps.
