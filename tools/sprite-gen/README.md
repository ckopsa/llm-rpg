# sprite-gen

Get battler sprites for kindred that don't have art yet — from a paper sketch
(`sketch2sprite.py`, the main path) or from an image model (`generate.py`).

## From a sketch — the main path

When the design already exists on paper, generating a creature is the wrong
move: it replaces the design instead of realizing it. `sketch2sprite.py` keeps
the drawing and adds only color and house style.

```bash
# 1. find the crop and read the silhouette
./sketch2sprite.py photo.jpg --crop 300,1100,1900,2800 --grid

# 2. write a features file with coordinates read off that grid, then
./sketch2sprite.py --features ../../games/emberwood/art/fufflehup.features.json \
                   -o ../../apps/web/public/assets/battlers/fufflehup.png
```

Two passes because they need different things. The silhouette survives a 25x
downscale; a face does not — eyes become smudges. So pass 1 prints the
silhouette as ASCII with coordinates, and pass 2 draws the features
deliberately at ~45x55 where every pixel is a decision. The features file is
data (`ellipse`, `rect`, `rounded_rect`, `arc`, `line`, `point` against the
named palette), so tweaking an eye is editing JSON, not code.

What makes it work on a real child's drawing: illumination is divided out so
warm paper under uneven light flattens to white, and gaps are bridged
(dilate → fill → erode) rather than flood-filled from outside — a six-year-old's
outline is not a closed curve, and an outside flood leaks through it and fills
the page.

Photograph tips: dark pen beats pencil, flat even light, shoot straight down,
and leave margin — `--crop` warns if the drawing touches the edge.

See `games/emberwood/art/fufflehup.features.json` for a worked example.

## Colorizing a sketch with an image model

`sketch2sprite.py` paints the silhouette procedurally. The alternative is to
let an image-**editing** model do the coloring — Gemini 2.5 Flash Image
("Nano Banana") or `gpt-image-1`. Editing, not text-to-image: the drawing goes
in as input and the model is asked only to add color and style, so the design
survives.

```bash
# 1. clean line art is a much better prompt image than a phone photo
./sketch2sprite.py --features ../../games/emberwood/art/fufflehup.features.json \
                   --lineart ~/Downloads/fufflehup-lineart.png

# 2. either drag that into aistudio.google.com with the prompt from colorize.py,
#    or run it headless:
export GEMINI_API_KEY=...
./colorize.py ~/Downloads/fufflehup-lineart.png --name fufflehup --n 3
```

Output lands in `out/fufflehup/` as both the raw edit and a spec-legal sprite.

**Compare before adopting.** The failure mode isn't a bad image, it's a
*lovely* image of a subtly different creature — smoother, cuter, more generic,
and no longer the one that was drawn. Put the candidates next to the
hand-painted sprite at 2x and pick deliberately. When the artist is a child,
this is the whole ballgame.

Where an editing model genuinely wins is **a set**: these models are good at
holding a look across many images, so a roster of ten sketches colored in one
pass will hang together better than ten hand-tuned features files. For a single
creature, the procedural path is faster and stays exactly on-model.

## From a text prompt

For creatures with no sketch. The hard part isn't generating an image, it's
that model output and the battler spec disagree on every axis: 1024px vs 104x80, thousands of colors vs eight,
soft alpha vs binary, floating subject vs standing on the cell floor. So the
pipeline is two halves — a container that generates, and a converter that makes
the result legal.

```
generate.py ──▶ ComfyUI (container, GPU) ──▶ raw-N.png
                                                 │
                                          pixelize.py
                                                 ▼
                                          sprite-N.png  (spec-legal)
```

## Local run

On the 3070 box:

```bash
./fetch-models.sh                 # SDXL base + Pixel Art XL LoRA, ~6.7GB, once
docker compose up --build -d      # ComfyUI on :8188
docker compose logs -f comfyui    # first boot loads SDXL; wait for healthy

pip install -r requirements.txt   # for the client, not the container
./generate.py flufflehup --batch 4
```

You get four candidates in `out/flufflehup/` — `raw-N.png` as generated and
`sprite-N.png` converted. Review them **at 2x**, since that's the integer scale
the battle screen draws at. Then:

```bash
cp out/flufflehup/sprite-2.png ../../apps/web/public/assets/battlers/flufflehup.png
```

and add the two manifest entries plus the species mapping (see below).

Generating on a different host than you edit on is fine — that's what `COMFY_URL`
is for:

```bash
COMFY_URL=http://gpubox:8188 ./generate.py flufflehup
```

## Converting art from anywhere else

`pixelize.py` doesn't care where the image came from — Retro Diffusion,
gpt-image-1, Midjourney, or a hand drawing you scanned:

```bash
./pixelize.py raw.png sprite.png --outline "#41527B"
./pixelize.py --verify sprite.png        # nonzero exit if it violates the spec
```

Flags worth knowing:

| Flag | Why |
|---|---|
| `--quantize coverage` (default) | Keeps small features. `median` weights by population and quantizes the *eyes* away on a mostly-one-color creature |
| `--resample nearest` | Use when the source is already true pixel art on its own grid; `box` (default) is right for smooth renders |
| `--colors N` | Pack range is 5-13. Lower reads cleaner at 55px |
| `--outline` | Defaults to the darkest color found, which on a pale creature is barely darker than the body. Passing the pack's ink `#41527B` usually reads better |

`--verify` is calibrated against the real pack: the existing Antifarea battlers
pass it unmodified, so it isn't enforcing rules the art itself would fail.

## Wiring a finished sprite in

```jsonc
// apps/web/public/assets/manifest.json
"sheets":  { "flufflehup": { "src": "/assets/battlers/flufflehup.png", "tileW": 104, "tileH": 80 } }
"sprites": { "flufflehup": { "sheet": "flufflehup", "anims": { "idle": { "frames": [[0,0]], "fps": 1 } } } }
```
```jsonc
// games/emberwood/sprites.json
"species": { "flufflehup": "flufflehup" }
```

Keep generated art in its own file rather than painting into `battlers_a.png`:
that sheet is Antifarea's CC-BY 3.0 work and mixing generated pixels into it
muddles the attribution `NOTICE` requires. Add a section to
`apps/web/public/assets/LICENSES.md` recording model, prompt, and the fact that
it's machine-generated — purely AI-generated images generally aren't
copyrightable, so provenance is the honest thing to record rather than a
license.

Nothing breaks while a sprite is missing: an unmapped species falls back to its
emoji glyph with a console warning.

## Scaling to Nomad

The container is already shaped for it, which is why it looks the way it does:

- **Weights aren't baked.** SDXL is ~6.5GB and moves on its own schedule; the
  image stays small and clients don't re-pull it. Locally that's a bind mount;
  under Nomad, a `host_volume` (or a prestart task running `fetch-models.sh`).
- **Config is env-driven** (`COMFY_HOST`, `COMFY_PORT`, `COMFY_URL`), so the
  same image runs under `docker run` and under a task with only config changing.
- **There's a real healthcheck** on `/system_stats` with a long start period.
  SDXL takes a while to load, and a task that reports healthy before the API
  answers fails its first job.
- **The client drives the HTTP API**, not the web UI. A jobspec cannot click.

The remaining Nomad-side pieces are the GPU device stanza
(`device "nvidia/gpu" { count = 1 }`, needs the NVIDIA device plugin on the
client), the volume mount, and deciding whether ComfyUI runs as a long-lived
service with `generate.py` as a batch job against it, or the whole thing is one
batch job per sprite. The service shape is better if you're iterating —
it pays the model load once instead of per sprite.
