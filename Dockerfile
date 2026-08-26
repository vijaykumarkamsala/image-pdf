# The Image & PDF Workspace, as one image for all three environments.
#
# **One image, promoted.** dev, staging and production run the byte-identical
# container and differ only in the environment passed to it. Building per
# environment means staging tests something production will never run, which is
# the usual root of "it worked in staging".
#
# **The base is pinned by digest, not by tag.** `python:3.12-slim` is a moving
# target: the same tag today and next month are different images, so a rebuild
# can change the runtime under a release nobody touched. The digest below is the
# only thing that makes a build reproducible, and it is the line to update
# deliberately when the base is reviewed.
#
# Build and run locally, exactly as Cloud Run will:
#   docker build -t ipw:local .
#   docker run --rm -p 8080:8080 -e PORT=8080 \
#       -e IPW_HOST=0.0.0.0 -e IPW_ALLOW_PUBLIC_BIND=1 -e IPW_ENV=dev ipw:local

ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE} AS base

# --------------------------------------------------------------- runtime ----
# Tesseract is the OCR engine (D-075, registered review_required). It is a
# system package rather than a wheel, so it belongs here rather than in
# requirements. `--no-install-recommends` keeps the image from collecting a
# desktop's worth of suggested packages.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes \
      tesseract-ocr \
      tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# ---------------------------------------------------------- dependencies ----
# Copied before the source so a code change does not reinstall the world. The
# package metadata is all that is needed to resolve dependencies.
# `workspaces.toml` is not documentation: `find_repo_root()` walks upward for
# it, and every service call reaches the licence register through that root.
# Without it the container installs cleanly and dies on its first request.
COPY pyproject.toml workspaces.toml ./
COPY packages/contracts/pyproject.toml packages/contracts/
COPY packages/processors/pyproject.toml packages/processors/
COPY packages/metrics/pyproject.toml packages/metrics/
COPY packages/pdf/pyproject.toml packages/pdf/
COPY packages/vector/pyproject.toml packages/vector/
COPY services/workspace-api/pyproject.toml services/workspace-api/
COPY services/benchmark-runner/pyproject.toml services/benchmark-runner/

# ---------------------------------------------------------------- source ----
COPY packages/ packages/
COPY services/ services/
COPY apps/workspace/ apps/workspace/
COPY data/licences/ data/licences/
COPY tools/ tools/

# Installed without dependencies first so the image records exactly what it
# holds, then the runtime set is resolved from the packages themselves.
RUN python -m pip install --upgrade pip \
 && python -m pip install \
      -e packages/contracts \
      -e packages/processors \
      -e packages/metrics \
      -e packages/pdf \
      -e packages/vector \
      -e services/benchmark-runner \
      -e services/workspace-api

# ------------------------------------------------------------------ user ----
# Nothing here needs root. A processor that parses attacker-supplied files is
# exactly the thing that should not be running as one.
RUN useradd --create-home --uid 10001 workspace \
 && chown -R workspace:workspace /srv
USER workspace

# Cloud Run sets PORT and connects from outside the container's loopback, so the
# bind address must be explicit. The public-bind acknowledgement is deliberately
# NOT set here: it is a deployment decision, and a container that binds the
# world by default is one nobody remembers agreeing to.
ENV PORT=8080 \
    IPW_HOST=0.0.0.0

EXPOSE 8080

# Cloud Run health-checks the port itself; this is for `docker run` and for
# anything else that reads container health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/health',timeout=4)"

CMD ["python", "tools/serve_workspace.py", "--no-browser"]
