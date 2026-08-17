#!/usr/bin/env python3
"""
Colorize a sketch with an image-EDITING model, then convert to a sprite.

The distinction that matters: `generate.py` does text-to-image, which invents
a creature from a description. That is the wrong tool when the design already
exists on paper -- it replaces the drawing instead of realizing it. Image
editing takes the drawing as input and is asked only to add color and style,
so the child's shapes survive.

    export GEMINI_API_KEY=...
    ./colorize.py ~/Downloads/fufflehup-lineart.png --name fufflehup

    export OPENAI_API_KEY=...
    ./colorize.py sketch.png --name fufflehup --provider openai

Writes out/<name>/edit-N.png (what the model returned) and sprite-N.png (the
same image through pixelize, spec-legal). Compare against the hand-painted
sprite before adopting either -- see README.

Install the SDK you need:  pip install google-genai   |   pip install openai
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
from pathlib import Path

import pixelize

HERE = Path(__file__).parent

# Written for an editing model, so it is phrased as instructions ABOUT the
# supplied drawing. Every clause about preserving shape is load-bearing: the
# failure mode is a model that produces a lovely generic creature which is no
# longer the one the child drew.
PROMPT = (
    "Color in this creature drawing. Keep the exact shapes, proportions and "
    "pose of the line art -- same silhouette, same ear shapes, same eye size "
    "and placement, same tail. Do not redraw, restyle or 'improve' the design, "
    "and do not add or remove body parts. "
    "Paint it as game sprite art: flat cel shading with a small number of "
    "colors, a cream and pale-yellow fluffy body, soft sage-green shadows, and "
    "a dark blue-grey outline. Simple rounded highlights, no gradients, no "
    "texture detail, no anti-aliased soft edges. "
    "Put it on a plain flat white background with nothing else in the image -- "
    "no scenery, no ground, no shadow beneath it, no text."
)


def gemini(image: Path, prompt: str, model: str, n: int) -> list[bytes]:
    try:
        from google import genai
    except ImportError:
        raise SystemExit("pip install google-genai")
    from PIL import Image as PILImage

    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise SystemExit("set GEMINI_API_KEY (get one at https://aistudio.google.com/apikey)")

    client = genai.Client(api_key=key)
    src = PILImage.open(image)
    out: list[bytes] = []
    for i in range(n):
        # One call per candidate: the image models return a single image per
        # request, and separate calls give genuinely different attempts.
        resp = client.models.generate_content(model=model, contents=[prompt, src])
        for cand in resp.candidates or []:
            for part in cand.content.parts or []:
                data = getattr(part, "inline_data", None)
                if data and data.data:
                    out.append(data.data)
        if not out:
            print(f"  attempt {i+1}: no image in response "
                  f"(often a safety block or a text-only reply)", file=sys.stderr)
    return out


def openai_edit(image: Path, prompt: str, model: str, n: int) -> list[bytes]:
    try:
        from openai import OpenAI
    except ImportError:
        raise SystemExit("pip install openai")
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("set OPENAI_API_KEY")

    client = OpenAI()
    with image.open("rb") as fh:
        resp = client.images.edit(
            model=model, image=fh, prompt=prompt, n=n, size="1024x1024",
            # Native transparency removes the background-keying step entirely,
            # which is the one real advantage this provider has here.
            background="transparent",
        )
    return [base64.b64decode(d.b64_json) for d in resp.data if d.b64_json]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", type=Path, help="line art or sketch to colorize")
    ap.add_argument("--name", required=True, help="species id, used for output paths")
    ap.add_argument("--provider", choices=("gemini", "openai"), default="gemini")
    ap.add_argument("--model", help="override the model id")
    ap.add_argument("--prompt", default=PROMPT)
    ap.add_argument("--n", type=int, default=3, help="candidates")
    ap.add_argument("--out", type=Path, default=HERE / "out")
    ap.add_argument("--colors", type=int, default=pixelize.COLORS)
    ap.add_argument("--outline", default="#41527B")
    args = ap.parse_args(argv)

    if not args.image.exists():
        raise SystemExit(f"no such image: {args.image}")

    if args.provider == "gemini":
        model = args.model or "gemini-2.5-flash-image"
        images = gemini(args.image, args.prompt, model, args.n)
    else:
        model = args.model or "gpt-image-1"
        images = openai_edit(args.image, args.prompt, model, args.n)

    if not images:
        raise SystemExit("the model returned no images")

    dest = args.out / args.name
    dest.mkdir(parents=True, exist_ok=True)
    failures = 0
    for i, blob in enumerate(images, 1):
        raw = dest / f"edit-{i}.png"
        raw.write_bytes(blob)
        sprite = dest / f"sprite-{i}.png"
        pixelize.convert(raw, sprite, colors=args.colors,
                         outline=pixelize._rgb(args.outline) if args.outline else None)
        problems = pixelize.verify(sprite, colors=args.colors)
        failures += bool(problems)
        print(f"  {'✓' if not problems else '✗'} {sprite}")
        for p in problems:
            print(f"      - {p}")

    print(f"\n{len(images)} candidate(s) in {dest}")
    print("compare against the hand-painted sprite at 2x before adopting one — an")
    print("editing model can quietly replace the design it was asked to preserve.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
