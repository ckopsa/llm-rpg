# Emberwood

*A creature-collection RPG about keeping the fire lit.*

The Emberwood valley is warmed by the Great Hearth, an old volcano tamed into a
network of waystone braziers. The braziers are going out. You are Elder Maren's
newest apprentice: choose a kindred, walk the old Keeper's road, relight the
braziers, and out-argue Vespera at Ashen Peak.

## Play

```bash
npm run validate -- games/emberwood/game.json
npm run play -- --game games/emberwood/game.json
```

Eleven maps. Eight above ground: Kilnhearth Village (start, heal-hearth, Biscuit),
the Paddock (`the-paddock`, through an unguarded gap in Kilnhearth's west
wall — Nib the paddock-hand, and a home for studio-made kindred so they never
dilute the tables below), Maren's Kiln
(starter choice of Emberling / Puddlit / Sproutle), Verdant Trail (first
brazier, three Trailhands), Mosshollow Town (market row, Keeper Fern, and
Wick's bee pasture in the southwest corner, where Flufflehup is common, Ocks
uncommon and Woxeley very rare — designed by Clark, Howie and Colton),
Mistmarsh (Hermit Sedge's Marshwick, Marsh-hand Odile), Cinder Ascent
(Vent-tender Mira, Trailhand Rooke, Keeper Bram at the high gate), and
Ashen Peak (cold braziers, Hushmoths, Vespera).

...and three below it. Out-arguing Vespera relights the Great Hearth, and
something under the mountain answers: a wall of cooled slag cracks open at the
east end of the summit onto **the Underhearth** — the Hearth-Mouth, the Ember
Veins, and the chamber of the First Hearth. That is where the game now ends.

Gating: `starter_chosen` opens the village gate, the relit Trail brazier
(`brazier_trail`) earns Sedge's trust, `badge_fern` opens the Ascent,
`badge_bram` opens the summit, `hearth_relit` opens the descent, and
`everember_stilled` ends the story.

## The Underhearth (post-Vespera)

You arrive around Lv 20 against Lv 24-28 content, with a hearth-fire at the
entrance and wild kindred in the veins to train on — Cindercoil, Emberclaw and
Hollowpuff, none of which live above ground. Measured win rates against
Everember, the fire at the bottom: **0% at Lv 20, ~15% at Lv 24, ~80% at Lv 28.**
It is meant to be trained for.

## Verified action script — the surface story

The engine is deterministic: the CLI always seeds its RNG with **seed 1**, so
the script below replays move-for-move from a fresh start to the relighting of
the Great Hearth at turn 1242. It is **1251 actions**.

It no longer ends the game — it ends the first act. The Underhearth below is
pinned separately by `packages/engine/test/underhearth.test.ts`, because
scripting the grind it needs would add several thousand actions to a file
nobody would read. Verified with:

```bash
npm run play -- --game games/emberwood/game.json --actions "<script below>"
```

Route summary (ends with the Hearth relit and the descent open): pick Emberling → beat Petto → relight the Trail brazier → catch
a Fuzzle → grind to Lv 10 → beat Wren and Juna → shop in Mosshollow → take
Sedge's Marshwick and beat Odile → beat Keeper Fern (Lv 12 Emberling +
salves) → grind Marshwick to 14 in the marsh → beat Rooke and Mira → catch a
wild Cindertail with warm snares → Marshwick 16 → beat Keeper Bram (Riptide
sweeps his rock line) → grind Cindertail 17 / Marshwick 20 on Hushmoths at the
summit hearth → Vespera: Cindertail walls Stormhound (electric immune),
Dust Kick shreds Boulderon and Ashenmaw for Marshwick's Tidal Crush, and
Cindertail lands the last Scree Slide at 10 HP, the Hearth catches, and the
slag cracks open behind her.

```
n n w w n n n w w w w n i w w n n n i s s s e e s e e e e n n n n n n n e e 
m2 m2 n n i w w w e w e w m1 catch e e e e n n n n n n e w e move2 move2 
move2 w e w e w e move2 move2 move2 w s s s s s s w i e n n n n n n e w e w e 
w e w e w e w e w e w e w e w e move2 move2 move2 w e move2 move2 w e w e w e 
move2 move2 move2 w e move2 move2 w s s s s s s w i e n n n n n n e w e move2 
move2 w e w e move2 move2 w e w e w e w e w e w e w e w e w e w e move4 w e w 
e w e move4 w e w e w e w e w e w e w e w e move4 move4 w e w e w e move4 
move4 w e w e w e w e w e w e move4 s m2 m2 m2 m2 w s s s s s w i e n n n e 
m4 m4 w w n n n n w n n n n n n n n w i i s w w w n i i s w w w s w w w w w w 
w w n w w w w i s e e s3 m2 m2 m2 m2 m4 m4 m4 m4 e e e e e e e e e e e e e e 
e e e e e e e e s e i w s s i m4 m4 m4 m4 m4 m4 n n e i n w w w w w w w w w w 
w w w w w w w w w w w e s n w e s n w e s switch3 move2 move2 move2 n w e s n 
w e s n w e s n w e s n w e s n w e s switch3 move2 move2 n w e s switch3 
move2 move2 move2 n w e s n w e s n w e s switch3 move2 move2 n w e s n w e s 
n w e s n w e s n w e s n w e s switch3 move2 move2 move2 n w e s n w e s n w 
e s n w e s n w e s n w e s switch3 move2 move2 n e e e e e e e e e e e e e e 
e e e e e s e i w n w w w w w w w w w w w w w w w w w w w w e s n w e s n w e 
s switch3 move2 move2 n w e s n w e s switch3 move2 move2 move2 n w e s n w e 
s n w e s n w e s n w e s switch3 move2 move2 n w e s n w e s n w e s n w e s 
switch3 move2 move2 move2 n e e e e e e e e e e e e e e e e e e n i i w w w w 
w n i i e s s s s e e e e e i w w w w w n n n n n n n w n n n n e e s3 m3 m3 
m3 m3 w w w w n n n e e e e s3 m3 m3 w w w w s s s e e s s s s e s s s s s s 
e e e e e i w w w w w n n n n n n n w n n n n e e n n n e e e e n n m4 m4 m4 
item4 s3 m4 item4 w w s3 m3 m3 m3 w e switch3 move3 move3 switch2 move1 move1 
w w s s s s s e s s s s s s e e e e e i w w w w w n n n n n n n w n n n n n e 
e switch3 move3 w e w e w e w e w e w e switch3 move3 move3 move3 w w s s s s 
s e s s s s s s e e e e e i w w w w w n n n n n n n w n n n n n e w w w n n e 
e e e s3 m3 m3 m3 m3 m3 m3 n n n n w n n n n e e n n n w w w w e e e n n n e 
e n n n w w w w w e w e w e w e w e w e w e w e w switch4 move4 move4 move4 e 
e e e e i w w w w w e w e w e w e w e w e w e w e w switch4 move4 move4 move4 
e e e e e i w w w w w e w e w e w e w switch4 move3 move3 move3 e e e e e i w 
w w w w e w e w e w e w e w e w e w e w e w e w e w e w e w e w switch4 move3 
move3 move3 move3 move3 e e e e e i w w w w w e w e w switch4 move3 move3 
move3 e e e e e i w w w w w e w switch4 move3 move3 move3 e e e e e i w w w w 
w w e w e w e w e w e w e w e w e w e w e w e switch3 move3 move3 move3 e e e 
e e i w w w w w switch3 move3 move3 move3 move3 e e e e e i w w w w w e w e w 
e w e w e w e w e w e w e w e w e w e w e w e w e w e w e w switch3 move3 
move3 move3 e e e e e i w w w w w e w e w e w e w switch3 move4 move4 move4 
move4 move4 move4 e e e e e i w w w w w e w e w e w e w switch3 move4 move4 e 
e e e e i w w w w w e e e e e i w w w w n n s4 m3 m3 m3 m4 m4 m4 m4 m4 s3 m4 
m4 m4 s4 m4 item3 m4 item3 m4 item3 m3 item3 m3 m3 m3 
```

Segment notes:
starter+exit (33) · Petto/brazier/catch (19) · trail grind to Lv10 (~150) ·
Wren+Juna (20) · shop+marsh+Odile (52) · Fern (35) · marsh grind to Lv14
(~230) · Cinder: Rooke, Mira, Cindertail catch (~140) · cinder grind + Bram
(~120) · peak grinds (~380) · Vespera (37).
