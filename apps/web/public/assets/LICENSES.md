# Asset Licenses

All art in this directory is original fantasy art from freely licensed packs.
No Nintendo / Pokémon assets are used anywhere in this project.

## zelda-like/ — "Zelda-like tilesets and sprites"

- Author: ArMM1998
- Source: https://opengameart.org/content/zelda-like-tilesets-and-sprites
- License: CC0 1.0 (public domain) — https://creativecommons.org/publicdomain/zero/1.0/
- Files used:
  - `Overworld.png` — 16x16 overworld tileset (grass, tall grass, animated water,
    paths, trees, cliffs, houses, sand paving, ...), unmodified.
  - `character.png` — 16x32 player character, 4-direction 4-frame walk cycles
    (rows: south, west, north, east) plus attack animations, unmodified.
  - `tallgrass.png` — derivative work: the two tall-grass/bush tiles at cells
    (0,6)-(1,6) of `Overworld.png` with the pale meadow background made
    transparent and greens darkened slightly, packed as a 2-frame 32x16 strip
    for use as an animated overlay. CC0.
  - `npc_elder.png`, `npc_guard.png`, `npc_villager.png` — derivative works:
    the 64x128 walk-cycle region of `character.png`, palette-swapped with
    ImageMagick (hair/shirt recolors) to create NPC variants. CC0 permits
    modification; these derivatives are likewise offered under CC0.

## battlers/battlers_a.png — "10 Fantasy RPG enemies" (repacked)

- Author: Charles Gabriel (Antifarea)
- Source: https://opengameart.org/content/10-fantasy-rpg-enemies
- License: CC-BY 3.0 — https://creativecommons.org/licenses/by/3.0/
- Attribution (required): "Monster battler sprites by Charles Gabriel
  (Antifarea), CC-BY 3.0, https://opengameart.org/content/10-fantasy-rpg-enemies"
- Modifications: the 27 non-humanoid monsters (slimes, snakes, cockatrices,
  lizards, rats, scorpions, wolves, ghosts, dragons — 3 color variants each)
  were extracted from the original `enemies.png`, background made transparent,
  and repacked onto a uniform 104x80 grid (3 columns x 9 rows). Pixel art
  itself is unmodified.

## battlers/fufflehup.png — original design by Clark, AI-colored

- Author: **Clark** — designed and drawn on paper. No part of it derives from
  the packs below; the creature and its linework are Clark's.
- Pipeline: photo → `sketch2sprite.py --lineart` (cleaned line art) → an image
  editing model asked to color it without changing the shapes → `pixelize.py
  --isolate` (104x80, 8 colors, binary alpha).
- So: **the design and drawing are human; the coloring is machine-assisted.**
  Worth stating precisely, because the two halves have different standing —
  purely AI-generated imagery generally isn't copyrightable, while the
  underlying drawing is Clark's work.
- A fully procedural alternative exists and needs no image model:
  `sketch2sprite.py --features games/emberwood/art/fufflehup.features.json`
  paints the same silhouette from the Emberwood palette.
- The source photographs live in `games/emberwood/art/sketches/`, gitignored by
  default so publishing them stays the artist's decision.

## battlers/woxeley.png — original design by the project author

- Author: **Colton Kopsa** (this project's author). Supplied colored, converted
  by `pixelize.py --isolate`.
- Converted with `--subject 46x70`: Woxeley is a tall biped, and the default
  landscape subject box would have shrunk her to fit a width she never needed.

## battlers/ocks.png — original design by Howie

- Author: **Howie** — designed the creature; supplied already colored, then
  converted by `pixelize.py --isolate` (104x80, 8 colors, binary alpha).
- Same standing as `fufflehup.png` above: the creature and its design are
  Howie's, the rendered artwork is machine-assisted. Source in
  `games/emberwood/art/sketches/`, gitignored.

## battlers/battlers_b.png — "10 Basic RPG enemies" (repacked)

- Author: Stephen Challener (Redshrike)
- Source: https://opengameart.org/content/10-basic-rpg-enemies
- License: CC-BY 3.0 (also offered OGA-BY 3.0) — https://creativecommons.org/licenses/by/3.0/
- Attribution (required): "Monster battler sprites by Stephen Challener
  (Redshrike), hosted by OpenGameArt.org,
  https://opengameart.org/content/10-basic-rpg-enemies"
- Modifications: the 7 non-humanoid creatures (spider, deep one, wasp, wyrm,
  eye horror, snap turtle, slime) were extracted from the original
  `rpgcritters2.png` and repacked onto a uniform 48x48 grid (7 columns x 1 row).
  Pixel art itself is unmodified.

## In-game attribution

Any distributed build of this game must reproduce the two CC-BY attribution
lines above (e.g. in a credits screen or bundled CREDITS file).
