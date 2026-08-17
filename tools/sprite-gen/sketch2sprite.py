#!/usr/bin/env python3
"""
Turn a photographed sketch into a battler sprite.

Built for the case where the DESIGN already exists on paper and only needs
color and house style -- the opposite of prompting a model for a creature.
The sketch decides the silhouette; a small features file decides the face.

Two passes, because they need different things:

  1. `--grid` extracts the silhouette and prints it as ASCII. A drawing scaled
     down 25x loses its face -- eyes become smudges -- so you read coordinates
     off this grid and write them into a features file.
  2. `--features f.json` paints that silhouette and draws the features on top,
     at sprite scale where every pixel is a decision.

    ./sketch2sprite.py sketch.jpg --crop 300,1100,1900,2800 --grid
    ./sketch2sprite.py sketch.jpg --features fufflehup.features.json -o out.png

The features file carries its own crop, so after the first run one argument
reproduces the sprite exactly.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

CELL = (104, 80)
SUBJECT = (62, 56)
FLOOR_MARGIN = 1

# Emberwood house palette: the pack's ink, plus a cream body ramp ending in
# sage so grass-typed kindred read as green-adjacent without being green.
PALETTE = {
    "light": "#FBF0CF",
    "body": "#E8D9A6",
    "shade": "#C6B885",
    "deep": "#96A277",
    "ink": "#41527B",
    "glint": "#FFFDF2",
}


def _rgb(text: str) -> tuple[int, int, int]:
    t = text.lstrip("#")
    return tuple(int(t[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _disk(r: int) -> np.ndarray:
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def extract(photo: Path, crop: tuple[int, int, int, int] | None, bridge: int,
            threshold: int) -> np.ndarray:
    """Silhouette mask at full photo resolution.

    A six-year-old's outline is not a closed curve, so an outside flood leaks
    and fills the page. Bridging (dilate -> fill -> erode) closes gaps up to
    2*bridge px instead, which is what makes this work on real drawings.
    """
    im = Image.open(photo).convert("L")
    if crop:
        im = im.crop(crop)
    a = np.asarray(im, dtype=np.float32)
    # Warm paper under uneven light: divide out a blurred copy so the page
    # flattens and only ink stays dark.
    bg = np.asarray(im.filter(ImageFilter.GaussianBlur(60)), dtype=np.float32)
    flat = np.clip(a / np.maximum(bg, 1) * 255, 0, 255)

    ink = flat < threshold
    d = ndimage.binary_dilation(ink, structure=_disk(bridge))
    f = ndimage.binary_fill_holes(d)
    e = ndimage.binary_erosion(f, structure=_disk(bridge))

    lab, n = ndimage.label(e)
    if not n:
        raise SystemExit("sketch2sprite: found no drawing. Check --crop and --threshold.")
    sizes = ndimage.sum(e, lab, range(1, n + 1))
    body = lab == (np.argmax(sizes) + 1)

    ys, xs = np.where(body)
    if xs.min() < 3 or ys.min() < 3 or xs.max() > body.shape[1] - 4 or ys.max() > body.shape[0] - 4:
        print("warning: the drawing touches the crop edge; widen --crop", file=sys.stderr)
    return body[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def lineart(photo: Path, crop: tuple[int, int, int, int] | None, threshold: int,
            long_edge: int = 1024) -> Image.Image:
    """Clean black-on-white line art, for handing to an image-editing model.

    A phone photo of a sketchbook page is a poor prompt image: warm paper, a
    thumb in frame, spiral binding, and whatever else shares the page. The
    model spends attention on all of it. This keeps her linework and throws
    the rest away.

    Deliberately NOT hard-thresholded -- ballpoint line weight varies, and
    flattening it to 1-bit snaps thin strokes and costs the drawing its
    confidence. Levels are stretched instead, so paper goes white and ink goes
    near-black while the pressure variation survives.
    """
    im = Image.open(photo).convert("L")
    if crop:
        im = im.crop(crop)
    a = np.asarray(im, dtype=np.float32)
    bg = np.asarray(im.filter(ImageFilter.GaussianBlur(60)), dtype=np.float32)
    flat = np.clip(a / np.maximum(bg, 1) * 255, 0, 255)

    black, white = threshold - 55, threshold + 25
    levelled = np.clip((flat - black) / max(1.0, white - black), 0, 1) * 255
    out = Image.fromarray(levelled.astype(np.uint8), "L").convert("RGB")

    scale = long_edge / max(out.size)
    if scale > 1:
        out = out.resize((round(out.width * scale), round(out.height * scale)), Image.LANCZOS)
    return out


def downscale(body: np.ndarray, subject: tuple[int, int]) -> np.ndarray:
    h, w = body.shape
    scale = min(subject[0] / w, subject[1] / h)
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    small = np.asarray(
        Image.fromarray((body * 255).astype(np.uint8)).resize(size, Image.Resampling.BOX),
        dtype=np.float32) / 255.0
    b = small >= 0.45
    # Detached fluff strokes read as dirt at 50px; keep the creature only.
    lab, n = ndimage.label(b)
    if n > 1:
        sizes = ndimage.sum(b, lab, range(1, n + 1))
        b = lab == (np.argmax(sizes) + 1)
    return b


def grid(b: np.ndarray) -> str:
    h, w = b.shape
    out = [f"silhouette {w}x{h}", "    " + "".join(str(x % 10) for x in range(w))]
    for y in range(h):
        out.append(f"{y:3d} " + "".join("#" if b[y, x] else "." for x in range(w)))
    return "\n".join(out)


def shade(b: np.ndarray, light: tuple[float, float], bands: list[float],
          palette: dict[str, str], model: str = "form") -> Image.Image:
    """Paint the silhouette.

    "radial" quantizes distance from a key light into bands. It is simple and
    it looks it: on a lumpy silhouette the band edges are straight lines that
    cut across the form like contour lines on a map.

    "form" (default) is how a pixel artist actually shades a round creature:
    a crisp rim of light along the lit edge, a core shadow hugging the opposite
    edge, and a broad mid-tone between. Because both rims are computed from the
    silhouette's own edge, the shading follows the shape instead of ignoring it.
    """
    sh, sw = b.shape
    rgb = np.zeros((sh, sw, 3), dtype=np.uint8)
    rgb[...] = _rgb(palette["body"])

    if model == "radial":
        yy = np.arange(sh)[:, None] / max(1, sh - 1)
        xx = np.arange(sw)[None, :] / max(1, sw - 1)
        lum = np.sqrt((xx - light[0]) ** 2 + (yy - light[1]) ** 2)
        lo, hi = lum[b].min(), lum[b].max()
        lum = (lum - lo) / max(1e-6, hi - lo)
        rgb[lum < bands[0]] = _rgb(palette["light"])
        rgb[lum > bands[1]] = _rgb(palette["shade"])
        rgb[lum > bands[2]] = _rgb(palette["deep"])
        return Image.fromarray(np.dstack([rgb, (b * 255).astype(np.uint8)]), "RGBA")

    ys, xs = np.where(b)
    cy, cx = ys.mean(), xs.mean()
    yy = (np.arange(sh)[:, None] - cy) / max(1, (ys.max() - ys.min()) / 2)
    xx = (np.arange(sw)[None, :] - cx) / max(1, (xs.max() - xs.min()) / 2)
    # light is a 0..1 position on the sprite; turn it into a direction from the
    # centroid, so proj > 0 means "facing the key light".
    lx, ly = 0.5 - light[0], 0.5 - light[1]
    n = max(1e-6, (lx * lx + ly * ly) ** 0.5)
    proj = -(xx * lx + yy * ly) / n

    # Shading is confined to a band along the silhouette edge. Letting it run
    # across the interior is what produced contour-map stripes: proj is linear
    # in x and y, so any threshold on it alone is a straight line.
    dist = ndimage.distance_transform_edt(b)
    band = dist <= max(2.0, dist.max() * 0.40)
    core = dist <= max(1.5, dist.max() * 0.22)
    rim = dist <= 1.5

    rgb[b & band & (proj < -bands[0])] = _rgb(palette["shade"])
    rgb[b & core & (proj < -bands[1])] = _rgb(palette["deep"])
    rgb[b & band & (proj > bands[0])] = _rgb(palette["light"])
    rgb[b & rim & (proj > bands[2])] = _rgb(palette["light"])
    return Image.fromarray(np.dstack([rgb, (b * 255).astype(np.uint8)]), "RGBA")


def draw_features(img: Image.Image, ops: list[dict], palette: dict[str, str]) -> Image.Image:
    d = ImageDraw.Draw(img)
    for op in ops:
        kind = op["op"]
        fill = (*_rgb(palette[op["fill"]]), 255) if "fill" in op else None
        outline = (*_rgb(palette[op["outline"]]), 255) if "outline" in op else None
        box = op.get("box")
        if kind == "ellipse":
            d.ellipse(box, fill=fill, outline=outline)
        elif kind == "rect":
            d.rectangle(box, fill=fill, outline=outline)
        elif kind == "rounded_rect":
            d.rounded_rectangle(box, radius=op.get("radius", 2), fill=fill, outline=outline)
        elif kind == "arc":
            d.arc(box, op["start"], op["end"], fill=fill)
        elif kind == "line":
            d.line([tuple(p) for p in op["points"]], fill=fill)
        elif kind == "point":
            for p in op["points"]:
                d.point(tuple(p), fill=fill)
        else:
            raise SystemExit(f"sketch2sprite: unknown draw op {kind!r}")
    return img


def compose(b: np.ndarray, img: Image.Image, palette: dict[str, str],
            cell: tuple[int, int], floor_margin: int) -> Image.Image:
    arr = np.asarray(img).copy()
    arr[~b] = (0, 0, 0, 0)          # features may never spill past the silhouette
    img = Image.fromarray(arr, "RGBA")

    grown = ndimage.binary_dilation(b, structure=np.ones((3, 3)))
    ring = np.zeros((*b.shape, 4), dtype=np.uint8)
    ring[grown & ~b] = (*_rgb(palette["ink"]), 255)
    out = Image.fromarray(ring, "RGBA")
    out.alpha_composite(img)

    canvas = Image.new("RGBA", cell, (0, 0, 0, 0))
    art = out.crop(out.getbbox())
    canvas.paste(art, ((cell[0] - art.width) // 2, cell[1] - floor_margin - art.height))
    return canvas


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("photo", type=Path, nargs="?")
    ap.add_argument("--features", type=Path, help="features JSON (carries its own crop)")
    ap.add_argument("--crop", help="x0,y0,x1,y1 in photo pixels")
    ap.add_argument("--bridge", type=int, default=14, help="gap-closing radius in photo pixels")
    ap.add_argument("--threshold", type=int, default=210, help="ink darkness cutoff")
    ap.add_argument("--grid", action="store_true", help="print the silhouette and exit")
    ap.add_argument("--lineart", type=Path,
                    help="write cleaned line art for an image-editing model and exit")
    ap.add_argument("-o", "--out", type=Path, default=Path("sprite.png"))
    args = ap.parse_args(argv)

    spec: dict = {}
    if args.features:
        spec = json.loads(args.features.read_text())
    photo = args.photo
    if not photo and "photo" in spec:
        # Relative to the features file, so the pair moves together.
        photo = (args.features.parent / spec["photo"]).resolve()
    if not photo:
        ap.error("give a photo path, or a features file containing one")

    crop = None
    if args.crop:
        crop = tuple(int(v) for v in args.crop.split(","))
    elif spec.get("crop"):
        crop = tuple(spec["crop"])

    if args.lineart:
        art = lineart(photo, crop, spec.get("threshold", args.threshold))
        args.lineart.parent.mkdir(parents=True, exist_ok=True)
        art.save(args.lineart)
        print(f"wrote {args.lineart} — {art.width}x{art.height}")
        return 0

    palette = {**PALETTE, **spec.get("palette", {})}
    body = extract(photo, crop, spec.get("bridge", args.bridge),
                   spec.get("threshold", args.threshold))
    b = downscale(body, tuple(spec.get("subject", SUBJECT)))

    if args.grid:
        print(grid(b))
        return 0

    img = shade(b, tuple(spec.get("light", (0.34, 0.26))),
                spec.get("bands", [0.28, 0.60, 0.82]), palette,
                spec.get("shading", "form"))
    img = draw_features(img, spec.get("draw", []), palette)
    out = compose(b, img, palette, tuple(spec.get("cell", CELL)),
                  spec.get("floor_margin", FLOOR_MARGIN))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.out)

    bb = out.getbbox()
    print(f"wrote {args.out} — subject {bb[2]-bb[0]}x{bb[3]-bb[1]}, "
          f"floor gap {out.height - bb[3]}px")

    import pixelize
    problems = pixelize.verify(args.out, colors=spec.get("colors", 8))
    for p in problems:
        print(f"  ! {p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
