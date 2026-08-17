#!/usr/bin/env python3
"""
Drive the sprite-gen ComfyUI container end to end: prompt in, spec-legal
battler sprites out.

    ./generate.py flufflehup --prompt "a dandelion seed-puff creature ..."
    ./generate.py flufflehup --seed 7 --batch 4          # more candidates
    COMFY_URL=http://gpubox:8188 ./generate.py flufflehup

It talks to ComfyUI's HTTP API rather than its web UI on purpose: a jobspec
cannot click. Everything the UI does interactively -- submit graph, wait,
collect images -- is three endpoints, and driving them here is what makes this
the same flow locally and under Nomad.

Each run writes, under out/<name>/:
    raw-N.png       what the model produced
    sprite-N.png    the same image conforming to the battler spec

Pick the one you like, copy it to apps/web/public/assets/battlers/, and add the
sheet + sprite entries to the manifest (see README).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
from pathlib import Path

import requests

import pixelize

HERE = Path(__file__).parent
DEFAULT_WORKFLOW = HERE / "workflows" / "pixel-battler.json"
COMFY_URL = os.environ.get("COMFY_URL", "http://localhost:8188")


def submit(base: str, graph: dict) -> str:
    r = requests.post(f"{base}/prompt", json={"prompt": graph}, timeout=30)
    if r.status_code == 400:
        # ComfyUI reports graph problems here (missing model file, unknown node,
        # bad wiring). Surfacing the body verbatim saves a UI round trip.
        raise SystemExit(f"ComfyUI rejected the graph:\n{json.dumps(r.json(), indent=2)}")
    r.raise_for_status()
    return r.json()["prompt_id"]


def wait(base: str, prompt_id: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = requests.get(f"{base}/history/{prompt_id}", timeout=30)
        r.raise_for_status()
        entry = r.json().get(prompt_id)
        if entry and entry.get("outputs"):
            return entry
        status = (entry or {}).get("status", {})
        if status.get("status_str") == "error":
            raise SystemExit(f"ComfyUI job failed:\n{json.dumps(status, indent=2)}")
        time.sleep(1.5)
    raise SystemExit(
        f"timed out after {timeout:.0f}s. On a cold container the first job also "
        f"pays for loading SDXL; retry or raise --timeout."
    )


def download(base: str, image: dict) -> bytes:
    q = urllib.parse.urlencode({
        "filename": image["filename"],
        "subfolder": image.get("subfolder", ""),
        "type": image.get("type", "output"),
    })
    r = requests.get(f"{base}/view?{q}", timeout=60)
    r.raise_for_status()
    return r.content


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="species id, e.g. flufflehup")
    ap.add_argument("--prompt", help="override the workflow's positive prompt")
    ap.add_argument("--negative", help="override the negative prompt")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--steps", type=int)
    ap.add_argument("--batch", type=int, default=4, help="candidates per run")
    ap.add_argument("--workflow", type=Path, default=DEFAULT_WORKFLOW)
    ap.add_argument("--out", type=Path, default=HERE / "out")
    ap.add_argument("--url", default=COMFY_URL)
    ap.add_argument("--timeout", type=float, default=600)
    # Conversion knobs, forwarded to pixelize.
    ap.add_argument("--colors", type=int, default=pixelize.COLORS)
    ap.add_argument("--outline", default="#41527B",
                    help="outline ink; the pack's dark blue-grey by default")
    ap.add_argument("--quantize", choices=tuple(pixelize.QUANTIZERS), default="coverage")
    ap.add_argument("--resample", choices=("box", "nearest"), default="box")
    args = ap.parse_args(argv)

    graph = json.loads(args.workflow.read_text())
    if args.prompt:
        graph["6"]["inputs"]["text"] = args.prompt
    if args.negative:
        graph["7"]["inputs"]["text"] = args.negative
    graph["3"]["inputs"]["seed"] = args.seed
    if args.steps:
        graph["3"]["inputs"]["steps"] = args.steps
    graph["5"]["inputs"]["batch_size"] = args.batch
    graph["9"]["inputs"]["filename_prefix"] = args.name

    base = args.url.rstrip("/")
    try:
        requests.get(f"{base}/system_stats", timeout=10).raise_for_status()
    except requests.RequestException as e:
        raise SystemExit(f"no ComfyUI at {base} ({e}). Is the container up?")

    print(f"submitting {args.batch} candidate(s) to {base} (seed {args.seed}) ...")
    prompt_id = submit(base, graph)
    started = time.monotonic()
    entry = wait(base, prompt_id, args.timeout)
    print(f"generated in {time.monotonic() - started:.0f}s")

    images = [img for out in entry["outputs"].values() for img in out.get("images", [])]
    if not images:
        raise SystemExit("job finished but produced no images")

    dest = args.out / args.name
    dest.mkdir(parents=True, exist_ok=True)
    failures = 0
    for i, image in enumerate(images, 1):
        raw = dest / f"raw-{i}.png"
        raw.write_bytes(download(base, image))
        sprite = dest / f"sprite-{i}.png"
        pixelize.convert(
            raw, sprite,
            colors=args.colors,
            quantize=args.quantize,
            resample=args.resample,
            outline=pixelize._rgb(args.outline) if args.outline else None,
        )
        problems = pixelize.verify(sprite, colors=args.colors)
        failures += bool(problems)
        mark = "✓" if not problems else "✗"
        print(f"  {mark} {sprite.relative_to(Path.cwd()) if sprite.is_relative_to(Path.cwd()) else sprite}")
        for p in problems:
            print(f"      - {p}")

    print(f"\n{len(images)} candidate(s) in {dest}")
    print("review them at 2x (that is how the battle screen draws them), then:")
    print(f"  cp {dest}/sprite-N.png apps/web/public/assets/battlers/{args.name}.png")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
