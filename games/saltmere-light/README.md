# Saltmere Light

A fog-bound harbor's lighthouse has gone dark — on purpose. Keeper Maris doused
the lamp because the dark kept the sea quiet. Take Brannoc's glimmerling up the
cliff path, earn Oda's vouch to pass the knotted bar, out-argue (and out-fight)
the Warden, and relight the great lamp.

Built end-to-end through the Forge MCP tools (acceptance test for
llm-rpg-85g.6) — no hand-written JSON.

- **Maps:** harbor → cliff-path → lighthouse
- **Catalog:** tide / gale / ember / stone; glimmerling → lanternjaw (Lv 9)
  evolution line; wilds (mistwisp, saltcrab, cinderpuff) on cliff-path
- **Trainers:** Deckhand Piet (line-of-sight, south range 3), Net-Mender Oda
  (gates the knotted bar, gifts a saltcrab), boss Warden Maris (cinderpuff 8,
  lanternjaw 8)
- **Economy:** chandlery stalls sell brine-salve (10) and kelp-snare (12);
  free heals at the keeper's kettle, the warm tide-pool, and the keeper's cot

## Golden path (script playtest, wins at turn 63)

```
# starter from Brannoc
east east north interact
# road east, portal to cliff-path
east east east east east east east east east
# east until Piet's line of sight
east east east east east east east
# Piet: saltcrab L5, saltcrab L6
move2 move2 move2 move2 move2 move2
# east end of the road
east east east east east east
# down to Oda
south south west interact
# Oda: cinderpuff L5, saltcrab L6 (evolution lands here)
move2 move2 move2 move2 move2 move2 move2 move2
# back up, through the knotted bar, portal to lighthouse
north north east east
# heal at the cot
north west west north interact
# up the tower to Warden Maris
east east north north north north north north interact
# Maris: cinderpuff L8, lanternjaw L8
move2 move2 move2 move2 move2 move2 move2 move2 move2 move2 move1 move1 move1 move1
# past Maris, approach the lamp from the west so it is the only neighbor
north north west north interact
```

`forge_playtest` explore (default seed) also wins: 95 steps, 8/8 battles,
finishing the boss at 6/32 HP.
