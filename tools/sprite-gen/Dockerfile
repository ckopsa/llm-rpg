# ComfyUI on CUDA, sized for generating battler sprites.
#
# Two deliberate choices, both aimed at the Nomad step rather than this one:
#
#   1. Model weights are NOT baked in. SDXL is ~6.5GB and versions on its own
#      clock; baking it makes a 10GB image that Nomad has to pull onto every
#      client. They live on a volume instead (host volume locally, host volume
#      or CSI plugin under Nomad).
#   2. Everything addressable is env-driven, so the same image runs under
#      `docker run` and under a Nomad task with only config changing.
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Pin this to a tag or commit before promoting the image past local use --
# ComfyUI's master moves fast and an unpinned rebuild is not the same artifact.
ARG COMFY_REF=master

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip git curl ca-certificates \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui \
    && cd comfyui \
    && git fetch --depth 1 origin "${COMFY_REF}" && git checkout FETCH_HEAD

WORKDIR /opt/comfyui
RUN pip3 install --no-cache-dir torch torchvision \
      --index-url https://download.pytorch.org/whl/cu124 \
    && pip3 install --no-cache-dir -r requirements.txt

# Mount points, not content. `fetch-models.sh` fills the first one.
VOLUME ["/opt/comfyui/models", "/opt/comfyui/output"]

ENV COMFY_HOST=0.0.0.0 \
    COMFY_PORT=8188
EXPOSE 8188

# Nomad needs a real readiness signal: SDXL takes a while to load and a task
# that reports healthy before the API answers will fail its first job.
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=12 \
  CMD curl -fsS "http://localhost:${COMFY_PORT}/system_stats" || exit 1

CMD ["sh", "-c", "python3 main.py --listen ${COMFY_HOST} --port ${COMFY_PORT}"]
