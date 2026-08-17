#!/usr/bin/env bash
# Populate ./models for the sprite-gen container.
#
# Kept out of the image on purpose (see Dockerfile). Run once locally; under
# Nomad, point the task at a host volume that already holds these, or run this
# as a prestart task.
set -euo pipefail

DIR="${1:-$(dirname "$0")/models}"
mkdir -p "$DIR/checkpoints" "$DIR/loras"

fetch() {
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then
    echo "have $(basename "$dest")"
    return
  fi
  echo "fetching $(basename "$dest") ..."
  curl -fL --progress-bar -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

# SDXL base. ~6.5GB.
fetch \
  "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors" \
  "$DIR/checkpoints/sd_xl_base_1.0.safetensors"

# Pixel Art XL LoRA (nerijs). ~170MB. This is the piece that makes output land
# on something like a pixel grid instead of a smooth illustration.
fetch \
  "https://huggingface.co/nerijs/pixel-art-xl/resolve/main/pixel-art-xl.safetensors" \
  "$DIR/loras/pixel-art-xl.safetensors"

echo
echo "models ready in $DIR"
du -sh "$DIR"/* 2>/dev/null || true
