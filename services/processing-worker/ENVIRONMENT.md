# Processing worker environment authority

Google Cloud Run is Linux, so Linux x86_64 is the sole authority for encoded
image bytes, deterministic goldens, browser screenshots and the repository-wide
coverage gate. Windows remains a required development-compatibility environment,
but it compares decoded pixels, dimensions, formats, metadata and behavior rather
than compressed bytes or browser screenshots.

## Pinned environment

The source of truth is [`Dockerfile`](Dockerfile). Its production `runtime`
target and derived `canonical-ci` target pin:

| Component | Pin |
| --- | --- |
| OS/Python image | `python:3.14.5-slim-bookworm@sha256:a9bee15510a364124aa24692899d269835683b883de42f7ebec8c293cf679ccb` |
| Debian packages | snapshot `20260911T000000Z` |
| Pillow | `12.3.0` |
| IPW Standard font | SHA-256 `69853909b940023570964e29cffe30da95aea8de3627736b5cd15ab30143169f` |
| libvips / pyvips (evidence only) | `8.18.5` / `3.1.1` |
| NumPy (evidence only) | `2.5.2` |
| Torch (evidence only) | `2.13.0+cpu`, CUDA absent, one CPU thread |
| Node | `24.10.0` from image digest `sha256:b8d2197aff9129d16c801a3e3e1b2a873c4946480f5a310f38056df2268c38d9` |
| Playwright / Chromium | `1.62.1` / `151.0.7922.34` |
| PostgreSQL integration service | `17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` |

`tools/verify_canonical_linux_environment.py` verifies these identities before
tests. It also rejects NVIDIA, CUDA and Triton distributions. The Debian snapshot
pins Chromium's native libraries and installed fallback font packages; browser
and worker use the same committed IPW Standard bytes where the product requires
that font.

## Production versus evidence dependencies

Build the Cloud Run worker with:

```text
docker build -f services/processing-worker/Dockerfile --target runtime -t ipw-processing-worker .
```

The production target contains the processing worker and its production package
closure. It proves that Torch, pyvips, the POC processor workspace and the
benchmark runner are absent. This preserves the production/benchmark boundary in
ADR-0015.

The `canonical-ci` target inherits the runtime target and adds pinned CPU Torch,
libvips, Node and Chromium only to execute the complete repository evidence set.
CPU-only Torch avoids both the unreviewed CUDA licence path and CUDA libraries'
process-RSS inflation. The worker's 768 MiB limit remains unchanged.

## Baseline changes

Normal pull-request CI is read-only. The manual `update_linux_baselines` workflow
input regenerates image fixtures, standard goldens and zero-tolerance Playwright
screenshots inside the canonical image, reruns all authoritative gates, and
uploads the results for human review. Baselines are committed only after that
review. Windows neither authors nor approves canonical bytes.
