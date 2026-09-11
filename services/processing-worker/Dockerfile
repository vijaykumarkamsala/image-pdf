# syntax=docker/dockerfile:1.7

# Linux x86_64 production and authoritative-evidence environment for the
# Product V2 processing worker. Tags document the release; digests identify the
# immutable inputs actually built.
ARG PYTHON_IMAGE=python:3.14.5-slim-bookworm@sha256:a9bee15510a364124aa24692899d269835683b883de42f7ebec8c293cf679ccb
ARG NODE_IMAGE=node:24.10.0-bookworm-slim@sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9

FROM ${NODE_IMAGE} AS node-runtime
FROM ${PYTHON_IMAGE} AS python-base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Kolkata \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /opt/ipw

# The worker target is the Cloud Run runtime. It intentionally excludes the POC
# processor/benchmark workspaces, Torch, NumPy, pyvips, Node and Chromium.
FROM python-base AS runtime

COPY requirements-dev.lock.txt workspaces.toml ./
COPY packages/contracts packages/contracts
COPY packages/inspection packages/inspection
COPY packages/jobs packages/jobs
COPY packages/storage packages/storage
COPY packages/licence-registry packages/licence-registry
COPY services/processing-worker services/processing-worker
COPY apps/web/public/fonts/ipw-standard.ttf apps/web/public/fonts/ipw-standard.ttf
COPY data/licences data/licences
COPY tools/verify_canonical_linux_environment.py tools/verify_canonical_linux_environment.py

RUN python -m pip install "setuptools==84.0.0" \
 && python -m pip install --no-build-isolation -c requirements-dev.lock.txt \
      -e packages/contracts \
      -e packages/inspection \
      -e packages/jobs \
      -e packages/storage \
      -e packages/licence-registry \
      -e services/processing-worker \
 && python -m pip check \
 && python tools/verify_canonical_linux_environment.py --runtime-only \
 && ! python -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('torch') else 1)" \
 && ! python -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('ipw.benchmark_runner') else 1)"

RUN useradd --create-home --uid 10001 worker \
 && chown -R worker:worker /opt/ipw
USER worker

ENV PORT=8080
EXPOSE 8080
CMD ["ipw-processing-worker"]

# Build the exact approved native libvips version for POC compatibility evidence.
# It is not copied into the production runtime target above.
FROM python-base AS libvips-builder

ARG DEBIAN_SNAPSHOT=20260911T000000Z
ARG LIBVIPS_VERSION=8.18.5
ARG LIBVIPS_SHA256=8c4e6332d818249ed05ce98e36e6ed8a08e3249ac70f69680842ab2e5fee8510

RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install --no-install-recommends --yes \
      build-essential ca-certificates curl meson ninja-build pkg-config \
      libexif-dev libexpat1-dev libglib2.0-dev libjpeg62-turbo-dev \
      liblcms2-dev liborc-0.4-dev libpng-dev libtiff-dev libwebp-dev \
 && curl --fail --location --silent --show-error \
      --output /tmp/libvips.tar.xz \
      "https://github.com/libvips/libvips/releases/download/v${LIBVIPS_VERSION}/vips-${LIBVIPS_VERSION}.tar.xz" \
 && echo "${LIBVIPS_SHA256}  /tmp/libvips.tar.xz" | sha256sum --check --strict \
 && mkdir /tmp/libvips \
 && tar --extract --xz --file /tmp/libvips.tar.xz --directory /tmp/libvips --strip-components=1 \
 && meson setup /tmp/libvips/build /tmp/libvips \
      --buildtype=release --prefix=/usr/local --libdir=lib \
      -Ddeprecated=false -Dintrospection=disabled -Dmodules=disabled \
 && meson compile --verbose -C /tmp/libvips/build \
 && meson install -C /tmp/libvips/build

# The canonical CI target inherits the production Python/Pillow/font boundary,
# then adds only test/benchmark dependencies. CPU Torch is installed explicitly
# from the approved index; a plain PyPI Torch install is forbidden.
FROM runtime AS canonical-ci
USER root

ARG DEBIAN_SNAPSHOT=20260911T000000Z
ENV OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    MALLOC_ARENA_MAX=2 \
    IPW_CANONICAL_LINUX=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    COVERAGE_RCFILE=.coveragerc-ci

RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install --no-install-recommends --yes \
      libexif12 libexpat1 libglib2.0-0 libjpeg62-turbo liblcms2-2 \
      liborc-0.4-0 libpng16-16 libtiff6 libwebp7 libwebpdemux2 libwebpmux3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY --from=libvips-builder /usr/local /usr/local
RUN ldconfig

COPY . .

RUN python -m pip install "setuptools==84.0.0" \
 && python -m pip install \
      -c requirements-dev.lock.txt \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      "torch==2.13.0+cpu" \
 && python -m pip install --no-build-isolation \
      -c requirements-dev.lock.txt \
      -r requirements-dev.txt \
      -e packages/contracts \
      -e packages/inspection \
      -e packages/jobs \
      -e packages/storage \
      -e packages/processors \
      -e packages/metrics \
      -e packages/pdf \
      -e packages/vector \
      -e packages/licence-registry \
      -e services/processing-worker \
      -e services/benchmark-runner \
      -e services/workspace-api \
 && python -m pip check \
 && npm ci \
 && npx playwright install --with-deps chromium \
 && python tools/verify_canonical_linux_environment.py

RUN chown -R worker:worker /opt/ipw /opt/ms-playwright
USER worker

CMD ["sh", "tools/run_canonical_linux_gates.sh"]
