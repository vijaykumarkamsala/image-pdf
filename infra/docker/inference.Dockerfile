# Pinned CPU inference runtime for the AI adapter (POC-006).
#
# Two things this file exists to guarantee, neither achievable on a developer
# machine:
#
#   1. A pinned runtime. Every measurement is only comparable against
#      measurements taken on the same build. "torch 2.13" is not a build.
#
#   2. An honest memory figure. Peak RSS is a process-lifetime high-water mark,
#      so two processors sharing one process report each other's peaks. A
#      container running one operation is the only place that number means what
#      a reader assumes (see MemoryUsage in the contract).
#
# STATUS: NOT BUILT. Docker is not installed on the development machine, so this
# definition is unexercised. It is written now because POC-006 requires it and
# because deferring it would mean writing it blind later. Before any figure
# produced inside it is treated as authoritative it must be built, and its output
# compared against a host run of the same asset.
#
# BEFORE FIRST AUTHORITATIVE BUILD - three things this file cannot supply from a
# machine with no Docker and no network:
#
#   [ ] Pin BASE_IMAGE to a digest, read from the registry. A tag is a moving
#       target. The digest is deliberately absent rather than guessed: a wrong
#       digest that looks precise is worse than an honest tag.
#   [ ] Add --require-hashes to the requirements install, with hashes resolved
#       against the real index at pin time.
#   [ ] Confirm the libvips package name and version on the chosen base.

ARG BASE_IMAGE=python:3.14-slim-bookworm
FROM ${BASE_IMAGE} AS base

# ---------------------------------------------------------------- provenance --
LABEL org.opencontainers.image.title="ipw-inference-runtime"
LABEL org.opencontainers.image.description="Pinned CPU inference runtime for the \
Image & PDF Workspace benchmark. Research and internal benchmark use only."
LABEL org.opencontainers.image.licenses="MIT"
LABEL ipw.licence.standing="research-only"
LABEL ipw.licence.note="Real-ESRGAN weights have no stated licence and derive from \
DIV2K, which is academic-research-only. See data/licences/register.json."

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Thread count is part of the measurement, not a detail. fp32 convolution is
    # deterministic for a fixed thread count and not across different ones, so a
    # container inheriting the host's core count would produce results that
    # silently fail to reproduce.
    OMP_NUM_THREADS=4 \
    MKL_NUM_THREADS=4 \
    TORCH_NUM_THREADS=4

# libvips for the deterministic control path, so the container matches what
# tools/install_libvips.py provides locally.
# libvips is LGPL-2.1+. Dynamic linking in a server-side container is the
# arrangement reviewed in ADR-0004; a bundled desktop or mobile application is a
# different question needing its own review (D-047, O-012).
RUN apt-get update \
 && apt-get install --no-install-recommends --yes libvips42 \
 && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------ runtime --
# The CPU index, explicitly. On Linux the default PyPI torch wheel bundles NVIDIA
# CUDA runtime libraries under the NVIDIA Software Licence Agreement - not
# permissive, and not reviewed. A plain `pip install torch` here would acquire
# unreviewed non-permissive components without anyone deciding to. This line is a
# licence control, not an optimisation.
RUN pip install --index-url https://download.pytorch.org/whl/cpu "torch==2.13.0+cpu"

COPY infra/docker/requirements-runtime.txt /tmp/requirements-runtime.txt
RUN pip install --requirement /tmp/requirements-runtime.txt

# ------------------------------------------------------------------ project --
WORKDIR /app
COPY packages/contracts /app/packages/contracts
COPY packages/processors /app/packages/processors
COPY services/benchmark-runner /app/services/benchmark-runner
COPY workspaces.toml /app/workspaces.toml
COPY tools/install_model_weights.py /app/tools/install_model_weights.py

RUN pip install --no-deps \
      /app/packages/contracts \
      /app/packages/processors \
      /app/services/benchmark-runner

# Weights are NOT baked into the image. No weight licence is stated anywhere in
# the Real-ESRGAN repository, so putting them in a layer would republish them -
# a decision nobody has taken. They are mounted at run time and verified by
# digest at load.
VOLUME ["/weights"]
ENV IPW_WEIGHTS_DIR=/weights

# Nothing here needs the network once built, and Gate B requires that. Enforced
# at run time with `docker run --network none`, and independently by the
# adapter's own no_network() guard - which is what makes the claim testable
# rather than merely declared.

RUN useradd --create-home --uid 10001 runner \
 && chown -R runner:runner /app
USER runner

# Fails the build if the architecture cannot be constructed. A container that
# starts and only then discovers it cannot build the model is a worse outcome
# than one that never ships.
RUN python -c "from ipw.processors.ai_adapters.rrdbnet import build_rrdbnet; \
build_rrdbnet(4); build_rrdbnet(2); print('architecture ok')"

ENTRYPOINT ["python", "-m", "ipw.benchmark_runner"]
CMD ["version"]
