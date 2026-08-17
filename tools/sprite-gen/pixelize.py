#!/usr/bin/env python3
"""
Turn a generated image into an Emberwood battler sprite.

Model output -- even from a pixel-art LoRA -- is large, smooth, and has
thousands of colors on a soft-edged background. The battler spec is the
opposite of all four:

  * a 104x80 cell (matching battlers_a), one frame, no padding rows
  * a ~55-65px subject sitting on the cell FLOOR, horizontally centered
  * <= 10 colors including a dark outline
  * BINARY alpha -- 0 or 255, nothing between

Everything between those two facts lives in this file. The renderer draws
battlers with imageSmoothingEnabled=false at integer scale 2, so a soft edge
does not blur, it shimmers; that is why the alpha threshold is not optional.

Usage:
    pixelize.py raw.png sprite.png                 # convert
    pixelize.py raw.png sprite.png --colors 6      # tighter palette
    pixelize.py --verify sprite.png                # check against the spec

Exit status is nonzero when --verify finds a violation, so this doubles as a
CI gate on generated art.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageFilter

# Matches battlers_a.png, so a new sprite renders at the same apparent size as
# the rest of the pack. See apps/web/public/assets/manifest.json.
CELL = (104, 80)
SUBJECT = (65, 55)  # max subject box; the pack ranges 55x46 (puffs) to 63x55 (Fuzzle)
COLORS = 8
FLOOR_MARGIN = 1  # transparent rows left below the subject

# Candidate sentinels for background keying; the first one absent from the
# source image wins, so art containing hot magenta does not lose pixels.
SENTINELS = [(255, 0, 255), (0, 255, 0), (255, 255, 0), (0, 255, 255)]


def _pick_sentinel(rgb: Image.Image) -> tuple[int, int, int]:
    present = {c for _, c in (rgb.getcolors(maxcolors=1 << 24) or [])}
    for candidate in SENTINELS:
        if candidate not in present:
            return candidate
    raise SystemExit("pixelize: image uses every sentinel color; pass --keep-alpha")


def key_background(img: Image.Image, tolerance: int) -> Image.Image:
    """Make a near-uniform background transparent by flooding in from the corners.

    Skipped when the generator already supplied real alpha (gpt-image-1's
    transparent background, or a ComfyUI graph ending in a matte node) -- that
    alpha is better than anything we can recover here.
    """
    if img.mode == "RGBA" and img.getchannel("A").getextrema()[0] < 255:
        return img

    rgb = img.convert("RGB")
    w, h = rgb.size
    sentinel = _pick_sentinel(rgb)
    flooded = rgb.copy()
    from PIL import ImageDraw

    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(flooded, xy, sentinel, thresh=tolerance)

    # Exact per-channel comparison: converting a difference to L would weight
    # the channels and could round a real 1-unit difference down to zero.
    diff = ImageChops.difference(flooded, Image.new("RGB", rgb.size, sentinel)).split()
    changed = ImageChops.lighter(ImageChops.lighter(diff[0], diff[1]), diff[2])
    alpha = changed.point(lambda v: 255 if v else 0)

    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def _trim(img: Image.Image) -> Image.Image:
    box = img.getbbox()
    if box is None:
        raise SystemExit("pixelize: image is fully transparent after background keying")
    return img.crop(box)


def isolate_subject(img: Image.Image) -> Image.Image:
    """Keep only the largest connected opaque region.

    Art that came from a drawing usually arrives with company -- speed lines,
    stray marks, a signature. They survive background keying, they stretch the
    bounding box, and the creature ends up shrunk into a corner of its own
    cell. Anything not touching the main mass goes.
    """
    from scipy import ndimage  # only needed on this path

    alpha = np.asarray(img.getchannel("A")) > 0
    lab, n = ndimage.label(alpha)
    if n <= 1:
        return img
    sizes = ndimage.sum(alpha, lab, range(1, n + 1))
    keep = lab == (int(np.argmax(sizes)) + 1)
    out = img.copy()
    a = np.asarray(out.getchannel("A")).copy()
    a[~keep] = 0
    out.putalpha(Image.fromarray(a))
    return out


def _fit(img: Image.Image, subject: tuple[int, int], resample: str) -> Image.Image:
    """Scale the subject into its box, preserving aspect ratio.

    Box averaging beats nearest for a smooth render (nearest drops every other
    pixel and shatters thin features); nearest is right when the source is
    already true pixel art on its own grid and just needs integer reduction.
    """
    sw, sh = subject
    scale = min(sw / img.width, sh / img.height)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    filt = Image.Resampling.NEAREST if resample == "nearest" else Image.Resampling.BOX
    return img.resize(size, filt)


def _opaque_colors(img: Image.Image) -> list[tuple[int, tuple[int, int, int]]]:
    """[(count, rgb)] over opaque pixels only, most common first."""
    counts = img.convert("RGBA").getcolors(maxcolors=1 << 24) or []
    merged: dict[tuple[int, int, int], int] = {}
    for n, (r, g, b, a) in counts:
        if a:
            merged[(r, g, b)] = merged.get((r, g, b), 0) + n
    return sorted(((n, c) for c, n in merged.items()), key=lambda kv: -kv[0])


QUANTIZERS = {
    "median": Image.Quantize.MEDIANCUT,
    "coverage": Image.Quantize.MAXCOVERAGE,
    "octree": Image.Quantize.FASTOCTREE,
}


def _quantize(img: Image.Image, colors: int, method: str) -> Image.Image:
    """Reduce to `colors` hues with no dithering, ignoring transparent pixels.

    Dithering is disabled on purpose: it invents checkerboards that read as
    noise at 2x, and it inflates the color count past the spec.

    The method matters more than it looks. MEDIANCUT weights by population, so
    on a creature that is 90% one body color it spends every slot on near
    identical body tints and quantizes the EYES away -- the one feature a 55px
    sprite cannot lose. MAXCOVERAGE keeps outliers, which is usually what a
    sprite wants.
    """
    alpha = img.getchannel("A")
    opaque = _opaque_colors(img)
    if not opaque:
        raise SystemExit("pixelize: nothing opaque to quantize")
    # Flatten the transparent region onto the subject's mean color so the
    # background does not spend palette slots it will never show.
    total = sum(n for n, _ in opaque)
    mean = tuple(sum(n * c[i] for n, c in opaque) // total for i in range(3))
    flat = Image.new("RGB", img.size, mean)
    flat.paste(img.convert("RGB"), (0, 0), alpha)

    q = flat.quantize(colors=colors, method=QUANTIZERS[method], dither=Image.Dither.NONE)
    out = q.convert("RGB").convert("RGBA")
    out.putalpha(alpha)
    return out


def _harden_alpha(img: Image.Image, threshold: int) -> Image.Image:
    alpha = img.getchannel("A").point(lambda v: 255 if v >= threshold else 0)
    out = img.copy()
    out.putalpha(alpha)
    return out


def _darkest(img: Image.Image) -> tuple[int, int, int]:
    opaque = [c for _, c in _opaque_colors(img)]
    return min(opaque, key=lambda c: c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114)


def _outline(img: Image.Image, color: tuple[int, int, int] | None) -> Image.Image:
    """Wrap the subject in a 1px ring, the way the Antifarea pack reads.

    The ring is drawn OUTSIDE the existing silhouette so it never eats detail
    from a subject that is already only ~55px wide.
    """
    alpha = img.getchannel("A")
    grown = alpha.filter(ImageFilter.MaxFilter(3))
    ring = ImageChops.subtract(grown, alpha)
    ink = color or _darkest(img)
    out = Image.new("RGBA", img.size, (*ink, 0))
    out.paste(Image.new("RGBA", img.size, (*ink, 255)), (0, 0), ring)
    out.paste(img, (0, 0), alpha)
    return out


def _place(img: Image.Image, cell: tuple[int, int], floor_margin: int) -> Image.Image:
    cw, ch = cell
    if img.width > cw or img.height > ch:
        raise SystemExit(
            f"pixelize: subject {img.width}x{img.height} does not fit cell {cw}x{ch}"
        )
    canvas = Image.new("RGBA", cell, (0, 0, 0, 0))
    x = (cw - img.width) // 2
    y = ch - floor_margin - img.height
    canvas.paste(img, (x, y))
    return canvas


def convert(
    src: Path,
    dst: Path,
    *,
    colors: int = COLORS,
    subject: tuple[int, int] = SUBJECT,
    cell: tuple[int, int] = CELL,
    resample: str = "box",
    quantize: str = "coverage",
    isolate: bool = False,
    tolerance: int = 24,
    alpha_threshold: int = 128,
    floor_margin: int = FLOOR_MARGIN,
    outline: tuple[int, int, int] | None = None,
    add_outline: bool = True,
) -> Image.Image:
    img = Image.open(src).convert("RGBA")
    img = key_background(img, tolerance)
    if isolate:
        img = isolate_subject(img)
    img = _trim(img)
    # Outline is added after scaling so the ring is exactly one FINAL pixel
    # wide, not one source pixel scaled down to nothing.
    img = _fit(img, (subject[0] - 2, subject[1] - 2) if add_outline else subject, resample)
    img = _harden_alpha(img, alpha_threshold)
    img = _trim(img)
    img = _quantize(img, colors - 1 if add_outline else colors, quantize)
    if add_outline:
        img = _outline(img, outline)
    img = _place(img, cell, floor_margin)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst)
    return img


def palette(img: Image.Image) -> list[tuple[tuple[int, int, int], int]]:
    return [(c, n) for n, c in _opaque_colors(img)]


def verify(path: Path, *, colors: int = COLORS, cell: tuple[int, int] = CELL) -> list[str]:
    """Check a sprite against the battler spec. Empty list means it is legal."""
    img = Image.open(path).convert("RGBA")
    problems: list[str] = []

    if img.size != cell:
        problems.append(f"size is {img.width}x{img.height}, expected {cell[0]}x{cell[1]}")

    alphas = {v for _, v in (img.getchannel("A").getcolors(maxcolors=256) or [])}
    stray = alphas - {0, 255}
    if stray:
        problems.append(
            f"alpha is not binary: {len(stray)} intermediate value(s) e.g. {sorted(stray)[:4]} "
            "-- the renderer draws with smoothing off, so these shimmer"
        )
    if alphas == {255}:
        problems.append("no transparency at all: the background was never keyed out")

    pal = palette(img)
    if len(pal) > colors:
        problems.append(f"{len(pal)} colors, spec allows {colors} (the pack uses 5-13)")

    box = img.getbbox()
    if box is None:
        problems.append("fully transparent")
        return problems

    floor_gap = cell[1] - box[3]
    if floor_gap > 3:
        problems.append(
            f"subject floats {floor_gap}px above the cell floor; battlers stand on it (gap 1-2)"
        )
    w, h = box[2] - box[0], box[3] - box[1]
    # Presence, not width. The pack happens to be landscape, but a tall biped
    # legitimately comes out narrow (a 0.55 aspect fitted to the cell height is
    # under 40 wide), and a width floor would reject correct art. What actually
    # matters is that it carries comparable visual weight and fits the cell.
    if w > cell[0] or h > cell[1]:
        problems.append(f"subject is {w}x{h}, larger than the {cell[0]}x{cell[1]} cell")
    elif max(w, h) < 46:
        problems.append(
            f"subject is {w}x{h}; its longest side should reach ~46+ to sit alongside "
            f"the pack (which ranges 55x46 to 98x70) instead of looking like a distant speck"
        )

    center_off = abs(((box[0] + box[2]) / 2) - cell[0] / 2)
    if center_off > 6:
        problems.append(f"subject is {center_off:.0f}px off horizontal center")

    return problems


def _size(text: str) -> tuple[int, int]:
    w, _, h = text.partition("x")
    return int(w), int(h)


def _rgb(text: str) -> tuple[int, int, int]:
    t = text.lstrip("#")
    return tuple(int(t[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, nargs="?", help="generated image")
    ap.add_argument("dst", type=Path, nargs="?", help="sprite to write")
    ap.add_argument("--verify", type=Path, help="check an existing sprite and exit")
    ap.add_argument("--colors", type=int, default=COLORS)
    ap.add_argument("--subject", type=_size, default=SUBJECT, help="max subject box, e.g. 60x50")
    ap.add_argument("--cell", type=_size, default=CELL)
    ap.add_argument("--resample", choices=("box", "nearest"), default="box",
                    help="box for smooth renders, nearest when the source is already pixel art")
    ap.add_argument("--quantize", choices=tuple(QUANTIZERS), default="coverage",
                    help="coverage keeps small features like eyes; median favors the dominant body color")
    ap.add_argument("--tolerance", type=int, default=24, help="background keying threshold")
    ap.add_argument("--alpha-threshold", type=int, default=128)
    ap.add_argument("--isolate", action="store_true",
                    help="drop everything not connected to the main subject (speed lines, stray marks)")
    ap.add_argument("--floor-margin", type=int, default=FLOOR_MARGIN)
    ap.add_argument("--outline", type=_rgb, default=None, help="outline color, default darkest")
    ap.add_argument("--no-outline", action="store_true")
    args = ap.parse_args(argv)

    if args.verify:
        problems = verify(args.verify, colors=args.colors, cell=args.cell)
        if problems:
            print(f"✗ {args.verify} violates the battler spec:")
            for p in problems:
                print(f"  - {p}")
            return 1
        print(f"✓ {args.verify} matches the battler spec")
        return 0

    if not args.src or not args.dst:
        ap.error("src and dst are required unless --verify is given")

    img = convert(
        args.src, args.dst,
        colors=args.colors, subject=args.subject, cell=args.cell,
        resample=args.resample, quantize=args.quantize, isolate=args.isolate,
        tolerance=args.tolerance,
        alpha_threshold=args.alpha_threshold, floor_margin=args.floor_margin,
        outline=args.outline, add_outline=not args.no_outline,
    )
    box = img.getbbox()
    print(f"wrote {args.dst} — cell {img.width}x{img.height}, "
          f"subject {box[2]-box[0]}x{box[3]-box[1]}, floor gap {img.height-box[3]}px")
    print("palette: " + " ".join("#%02X%02X%02X" % c for c, _ in palette(img)))
    problems = verify(args.dst, colors=args.colors, cell=args.cell)
    for p in problems:
        print(f"  ! {p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
