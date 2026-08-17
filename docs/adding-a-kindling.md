# Adding a kindling — from a drawing to a catchable creature

The end-to-end workflow for putting a new creature in a game: art, catalog
entry, somewhere to live, and the checks that prove it landed. Written from
doing it twice (Flufflehup and Ocks in `games/emberwood`).

A sprite is optional. **An unmapped species falls back to its emoji glyph with
a console warning** — nothing breaks while art is pending, so the catalog half
and the art half can proceed independently.

---

## 1. Art

Three routes into the same 104x80 target. Pick by what you're starting from.

### From a paper sketch, no image model

```bash
cd tools/sprite-gen
./sketch2sprite.py photo.jpg --crop 300,1100,1900,2800 --grid      # read coordinates
./sketch2sprite.py --features ../../games/<game>/art/<name>.features.json \
                   -o ../../apps/web/public/assets/battlers/<name>.png
```

The silhouette survives a 25x downscale; a face does not. So pass 1 prints the
extracted silhouette as ASCII, and pass 2 draws features at ~45x55 from a
features file you write against those coordinates. Free, offline, exactly
on-palette.

### From a paper sketch, colored by an image model — *usually the best result*

```bash
./sketch2sprite.py --features <name>.features.json --lineart ~/lineart.png
# drag lineart.png into aistudio.google.com with the prompt from colorize.py,
# or run it headless:
export GEMINI_API_KEY=...
./colorize.py ~/lineart.png --name <name> --n 3
```

Use an image **editing** model, never text-to-image. Editing takes the drawing
as input and adds only color; text-to-image invents a different creature from
a description. Feed it the cleaned line art rather than the phone photo — warm
paper, a thumb in frame and spiral binding all compete for the model's
attention.

### From art that's already colored

```bash
./pixelize.py source.png ../../apps/web/public/assets/battlers/<name>.png \
              --isolate --colors 8 --outline "#41527B"
```

`--isolate` keeps only the largest connected region. Art that came from a
drawing arrives with company — speed lines, stray marks, a signature — which
survive background keying, stretch the bounding box, and shrink the creature
into a corner of its own cell.

### Checking it

```bash
./pixelize.py --verify apps/web/public/assets/battlers/<name>.png
```

Exit status is nonzero on a violation, so this works as a CI gate. It checks
the 104x80 cell, binary alpha, palette size, that the subject stands on the
cell floor, and that it is horizontally centred. It is calibrated against the
bundled pack — the existing battlers pass it unmodified, so it is not
enforcing rules the art itself would fail.

Review at **2x**. That is the integer scale the battle screen draws at, and
things that read fine at 8x fall apart there.

## 2. Wire the sprite up

```jsonc
// apps/web/public/assets/manifest.json
"sheets":  { "battlers_<name>": { "src": "/assets/battlers/<name>.png", "tileW": 104, "tileH": 80 } }
"sprites": { "<name>": { "sheet": "battlers_<name>", "anims": { "idle": { "frames": [[0,0]], "fps": 1 } } } }
```
```jsonc
// games/<game>/sprites.json
"species": { "<speciesId>": "<name>" }
```

Name the sheet `battlers_*`. The sprite-preview page (`/sprites.html`) selects
by sheet prefix, so a sheet named anything else silently hides the art you
most want to look at.

Keep original art in its own file rather than painting into a pack sheet —
those are CC-BY and mixing pixels in muddles the attribution `NOTICE`
requires. Add a section to `apps/web/public/assets/LICENSES.md`. If a model
did the coloring, say so and say which half is human: the design and drawing
carry different standing from the rendered pixels.

## 3. Catalog entry

In `games/<game>/game.json` under `catalog.species`:

```jsonc
{
  "id": "ocks", "name": "Ocks", "glyph": "🌩",
  "types": ["water", "electric"],
  "baseStats": { "hp": 66, "atk": 60, "def": 68, "spd": 42 },
  "learnset": [ { "level": 1, "moveId": "bonk" }, /* ... */ ],
  "catchRate": 0.28, "xpYield": 130
}
```

- **Every `moveId` must already exist** in `catalog.moves`. New mechanics are
  new schema'd data, not free text.
- Cover **Lv 1-22** so a creature caught late still learns things. Level-ups
  replace the oldest of four moves, so 6-7 entries is the useful range.
- Give it a **stat identity that isn't already taken** — check the design
  bible's identity line. Ocks exists as a slow electric wall precisely because
  every other electric in Emberwood is fast and frail.
- The **glyph is required** and is what renders until a sprite exists. Pick one
  no other species uses.

## 4. Somewhere to live

An orphan species is unobtainable. Add it to a map's `encounters.table`, hand
it out with `give_species`, or give it to a trainer.

**The trap, and it is a real one:** encounter tables are per-map, and adding an
entry to an existing table reweights `rng.pickWeighted`. In `games/emberwood`,
`packages/engine/test/emberwood.test.ts` replays a 1251-action script and
asserts a win at turn 1242 — touching any table the route passes through
desyncs every wild draw downstream and the run stops winning. The explorer
cannot regenerate that script (it stalls well short of the end), so the route
is effectively hand-tuned and irreplaceable.

The way around it is a table the pinned route never rolls on: Flufflehup and
Ocks share a patch of tall grass in a corner of Mosshollow that the script
never walks through. There is no per-tile table, so **one map means one table**
— creatures that share a map share a draw. Verify with the pinned test, not by
reasoning:

```bash
npx vitest run packages/engine/test/emberwood.test.ts
```

## 5. Prove it landed

Don't assume the chain resolves — check it.

```bash
npm run validate -- games/<game>/game.json   # zero errors AND zero warnings
npm test                                     # pinned playthroughs
npx tsc --noEmit -p apps/web
```

Then confirm the species → sprite → sheet → file chain end to end, and that the
creature actually spawns. A short script that drops a sim onto the wild tiles
across many seeds answers "is it reachable and at what rate" far better than
playing does:

```
pasture encounters over 80 seeds: { flufflehup: 59, ocks: 21 }
```

To see it: `npm run web`, then `/sprites.html` for the battler strip (original
art leads it), or load a save placed next to the wild patch and step in.

## Checklist

- [ ] Sprite passes `pixelize.py --verify`, reviewed at 2x
- [ ] `manifest.json` sheet (named `battlers_*`) + sprite entry
- [ ] `games/<game>/sprites.json` species mapping
- [ ] `LICENSES.md` provenance, saying which half is human
- [ ] Catalog entry: existing moves only, Lv 1-22, unused glyph, distinct stat identity
- [ ] Obtainable — encounters, gift, or trainer
- [ ] Pinned playthrough still wins
- [ ] Validate clean: zero errors, zero warnings
- [ ] Design bible roster row updated
