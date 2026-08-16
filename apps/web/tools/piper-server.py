#!/usr/bin/env python3
"""
Local neural text-to-speech for the web renderer, so read-aloud works in any
browser — including ones with no usable Web Speech backend at all (Brave on
Linux answers speak() with "synthesis-failed"), and without sending a line of
the game's text to anyone's servers.

Loads a Piper voice once and serves WAV over HTTP on localhost. The dev server
spawns this (see piper-plugin.ts) and proxies /__tts to it; the browser never
talks to this port directly.

  GET /health            -> {"ok":true,"voice":...,"voices":[...]}
  GET /speak?text=&rate=&voice= -> audio/wav

Standalone use (any static build, no Vite):
  python3 apps/web/tools/piper-server.py --port 5174
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import threading
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Where Piper voices live: the AUR packages install under /usr/share, and a
# hand-downloaded voice usually lands in the XDG data dir.
VOICE_DIRS = [
    Path.home() / ".local/share/piper-voices",
    Path("/usr/share/piper-voices"),
]
# Quality tiers, fastest first. "medium" synthesizes ~8x faster than "high"
# for no audible loss at game volume, so it is the better default by far.
QUALITY_ORDER = ["medium", "low", "high", "x_low"]

_cache: OrderedDict[tuple, bytes] = OrderedDict()
_cache_lock = threading.Lock()
CACHE_MAX = 256


def discover() -> list[Path]:
    """Every .onnx voice on this machine, best default first."""
    found: list[Path] = []
    for root in VOICE_DIRS:
        if root.is_dir():
            found.extend(sorted(root.rglob("*.onnx")))

    def rank(p: Path) -> tuple:
        name = p.name
        quality = next((i for i, q in enumerate(QUALITY_ORDER) if f"-{q}" in name), len(QUALITY_ORDER))
        lang = 0 if name.startswith("en_US") else 1 if name.startswith("en") else 2
        return (lang, quality, name)

    return sorted(found, key=rank)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # quiet: the dev server owns the console
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Same-origin through the dev-server proxy in normal use; permissive
        # so a static build can also point straight at this port.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        url = urlparse(self.path)
        route = url.path.rsplit("/", 1)[-1]
        query = parse_qs(url.query)

        if route == "health":
            self._json(200, {
                "ok": True,
                "voice": self.server.voice_name,
                "voices": [p.stem for p in self.server.available],
            })
            return

        if route != "speak":
            self._json(404, {"ok": False, "error": f"no route {url.path}"})
            return

        text = (query.get("text") or [""])[0].strip()
        if not text:
            self._json(400, {"ok": False, "error": "text is required"})
            return
        try:
            rate = float((query.get("rate") or ["1"])[0])
        except ValueError:
            rate = 1.0
        rate = min(max(rate, 0.4), 2.0)

        want = (query.get("voice") or [""])[0] or None
        try:
            voice_name = self.server.resolve(want)
        except KeyError:
            self._json(400, {"ok": False, "error": f"no voice {want!r}"})
            return

        key = (voice_name, round(rate, 3), text)
        with _cache_lock:
            hit = _cache.get(key)
            if hit is not None:
                _cache.move_to_end(key)
        if hit is None:
            try:
                hit = self.server.synth(text, rate, voice_name)
            except Exception as exc:  # a bad line must not kill the server
                self._json(500, {"ok": False, "error": str(exc)})
                return
            with _cache_lock:
                _cache[key] = hit
                while len(_cache) > CACHE_MAX:
                    _cache.popitem(last=False)
        self._send(200, hit, "audio/wav")


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, voice_path: Path, available: list[Path]):
        super().__init__(addr, Handler)
        from piper import PiperVoice  # imported late so --list works without onnx

        self.available = available
        self.voice_name = voice_path.stem
        self._paths = {p.stem: p for p in available}
        self._paths.setdefault(voice_path.stem, voice_path)
        # Voices are loaded on first use and kept — ~60MB of ONNX each, which
        # is cheap next to re-loading on every line.
        self._voices = {voice_path.stem: PiperVoice.load(str(voice_path))}
        self._lock = threading.Lock()

    def resolve(self, want: str | None) -> str:
        """Voice name to use, loading it if this is its first request."""
        if not want or want == self.voice_name:
            return self.voice_name
        if want not in self._paths:
            raise KeyError(want)
        with self._lock:
            if want not in self._voices:
                from piper import PiperVoice

                self._voices[want] = PiperVoice.load(str(self._paths[want]))
        return want

    def synth(self, text: str, rate: float, voice: str) -> bytes:
        buf = io.BytesIO()
        # length_scale is inverse speed: 0.5 speed = twice as long per phoneme.
        from piper import SynthesisConfig

        cfg = SynthesisConfig(length_scale=1.0 / rate)
        with self._lock:  # one ONNX session, one caller at a time
            with wave.open(buf, "wb") as out:
                self._voices[voice].synthesize_wav(text, out, syn_config=cfg)
        return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=0, help="0 picks a free port")
    ap.add_argument("--voice", help="voice name or .onnx path (default: best local)")
    ap.add_argument("--list", action="store_true", help="list voices and exit")
    args = ap.parse_args()

    available = discover()
    if args.list:
        for p in available:
            print(p)
        return 0
    if not available and not args.voice:
        print(json.dumps({"ok": False, "error": "no Piper voices found"}), flush=True)
        return 1

    chosen = None
    if args.voice:
        as_path = Path(args.voice)
        chosen = as_path if as_path.is_file() else next(
            (p for p in available if p.stem == args.voice), None
        )
        if chosen is None:
            print(json.dumps({"ok": False, "error": f"no voice {args.voice!r}"}), flush=True)
            return 1
    else:
        chosen = available[0]

    try:
        server = Server(("127.0.0.1", args.port), chosen, available)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
        return 1

    # The parent reads this line to learn the port it should proxy to.
    print(json.dumps({"ok": True, "port": server.server_address[1], "voice": chosen.stem}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
