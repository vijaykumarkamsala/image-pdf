# Current implementation — handoff for independent audit

Prepared 28 August 2026 for an independent product and technical audit.
Everything here describes code that exists in the repository at the commit
below. Nothing was changed, fixed or added to produce this document.

**Read this first:** the audit brief asks about React and Node.js
responsibilities. **There is no React in this repository, and Node.js does not
serve the application.** See [Technology stack](#technology-stack). If the brief
was written against a different codebase, that discrepancy needs resolving
before the audit proceeds.

---

## 1. Git state

| | |
|---|---|
| Branch | `main` |
| Commit | `2cd007a` — *Say what a control does, and what a number will get you* |
| Tag | `handoff-audit-2026-08-28` (annotated, points at `2cd007a`) |
| Working tree | Clean — no uncommitted changes |
| Tracked files | 320 |
| Remote | `https://github.com/vijaykumarkamsala/image-pdf.git` |

### What is deliberately not in Git

Verified by `git ls-files` — none of the following are tracked, and
`.gitignore` excludes them:

* `.env` and any real configuration values (`.env.example` is tracked and holds
  names only)
* Service-account keys (`*-sa.json`, `service-account*.json`, `*.pem`, `*.key`)
* Model weights (`*.pth`, `*.pt`, `*.ckpt`, `*.safetensors`, `*.onnx`, `*.bin`)
* `.venv/`, `node_modules/`, `.tools/` (downloaded libvips DLLs)
* `data/local-storage/` — uploaded and processed customer files
* `data/corpus/images/` — evaluation corpus
* Generated benchmark output (`data/runs/`, most of `data/reports/`)

Largest tracked file is 82 KB of source. There is no binary blob problem.

---

## 2. Repository structure

Dependency and generated folders omitted. Counts are tracked files.

```
apps/
  workspace/          5    THE CUSTOMER APPLICATION (vanilla JS, no framework)
  browser-lab/       11    measurement harness, NOT the product
packages/
  contracts/         22    Pydantic models — the shared vocabulary
  contracts-ts/       8    TypeScript mirror of the contracts, generated
  processors/        41    imaging engines, AI adapters, inspection
  pdf/               24    PDF reader/writer, redaction, OCR, compression
  vector/             9    raster → SVG tracing
  metrics/            6    PSNR / SSIM
  schemas/           18    generated JSON Schema (v1)
services/
  workspace-api/     19    THE APPLICATION SERVER (stdlib http.server)
  benchmark-runner/  30    POC benchmark CLI — mostly not used by the app
data/
  fixtures/          12    synthetic test images
  goldens/           37    byte-exact reference outputs
  licences/           1    licence register (47+ components)
  manifests/         11    benchmark manifests
docs/                15    including 8 ADRs
infra/docker/         3
deploy/               1
tools/                     developer scripts (fixtures, schema export, checks)
```

---

## 3. Architecture and technology stack

### What actually runs

| Layer | Technology | Notes |
|---|---|---|
| Browser UI | **Vanilla JavaScript ES modules** | `apps/workspace/*.js`. No framework, no build step, no bundler. |
| Styling | **Hand-written CSS** | One file, `styles.css`, ~1,600 lines with custom-property tokens. |
| Application server | **Python stdlib `http.server`** | `services/workspace-api`. `ThreadingTCPServer`, one thread per request. No Flask/FastAPI/Django. |
| Imaging | **Pillow** (primary), **libvips** via pyvips (optional) | Two engines behind one protocol. |
| AI | **PyTorch** (CPU) | Real-ESRGAN and SwinIR adapters. Weights not in repo. |
| Contracts | **Pydantic v2** → JSON Schema → TypeScript | Generated, drift-checked in CI. |
| Database | **Postgres via pg8000** | Schema and migration runner exist; **not wired to any UI feature.** |

### Node.js responsibilities — limited

Node is **not** part of serving the application. It is used for:

* `packages/contracts-ts` — TypeScript types generated from the JSON Schema,
  with 22 tests that verify canonical serialisation
* `apps/browser-lab` — a separate measurement harness for deciding
  local-vs-cloud processing thresholds (open decision O-003). Not the product.
* `npm run typecheck` / `npm test` in CI

`package.json` declares exactly two devDependencies: `@types/node`,
`typescript`. There are no runtime JS dependencies at all.

### React responsibilities — none

`grep -rn "react"` across every `package.json` returns nothing. The customer UI
is three hand-written ES modules totalling ~3,500 lines:

| File | Lines | Role |
|---|---|---|
| `apps/workspace/app.js` | 1,892 | image workspace, canvas, zoom, crop, palette, export |
| `apps/workspace/pdf-view.js` | ~800 | PDF page grid and PDF operations |
| `apps/workspace/batch-view.js` | ~700 | batch grid and batch runs |

---

## 4. Applications, services and packages

### Applications

**`apps/workspace`** — the customer-facing application. Static HTML, CSS and
three ES modules, served by the Python process. No build step; the files are
served as authored.

**`apps/browser-lab`** — TypeScript measurement harness. Its own README states
it is *"a measurement harness, not the customer application"*. Compiled output
(`public/dist/`) is gitignored.

### Services

**`services/workspace-api`** — the only service the application talks to.

| Module | Role |
|---|---|
| `http.py` | 23 routes, request/response, startup banner, `serve()` |
| `server.py` | `WorkspaceService` — every operation. **2,000 lines, 82 KB.** |
| `catalogue.py` | the operation catalogue the UI renders itself from |
| `storage.py` | `LocalStorage` / `GcsStorage`, GCS V4 signing by hand |
| `config.py` | environment settings and validation |
| `database.py` | connection + migration runner |
| `jobs.py`, `worker.py`, `handlers.py`, `pool.py` | queue, worker, job handlers, connection pool — **none reachable from the UI** |
| `licence_guard.py` | refuses to start production on uncleared model weights |

**`services/benchmark-runner`** — a POC benchmark CLI. **Two of its modules are
load-bearing for the application** (`licence_register`, `workspace`); the other
17 are not used by the app. See `PYTHON_CODE_INVENTORY.md`.

### Packages

`contracts` (shared models) · `processors` (imaging + AI) · `pdf` · `vector` ·
`metrics` · `schemas` · `contracts-ts`.

---

## 5. Data flow: upload → preview → processing → export

All in-process. No queue, no worker, no database participates.

```
1  Browser: user drops a file
   apps/workspace/app.js  load()

2  Optionally POST /api/uploads/sign
   → a signed URL; browser PUTs the bytes straight to storage
   → subsequent calls send { object: "uploads/..." } instead of base64
   Falls back to inline base64 when signing is unavailable.

3  POST /api/inspect          (header parsing, risk flags, decision)
   → facts panel

4  GET /api/catalogue         (once, at boot)
   → the tool icons are built from this response

5  POST /api/process { operation, settings, image|object }
   http.py _process → WorkspaceService.process
     → _build_settings   validates against the Pydantic contract
     → _processor_for    picks Pillow/libvips, or an AI adapter
     → guarded_process   runs it in a temp workspace
     → deliver()         result ≤ 1 MB inline as a data URL,
                         larger written to storage and returned as a link

6  Browser: state.past.push(previous); state.current = result
   canvas re-renders from state.current.dataUrl

7  Export: btn-download (top bar) writes state.current.dataUrl to a file,
   or the Export panel calls /api/process (JPEG/PNG), /api/pdf, or
   /api/vectorise depending on the chosen format.
```

**Every operation is a full round trip.** Nothing is processed in the browser.

---

## 6. How the browser talks to Python

`fetch` with `POST` and a JSON body, to same-origin `/api/*`. One helper:

```js
async function api(route, body) { … }   // apps/workspace/app.js
```

There is no client library, no generated client, no websocket, no
server-sent events, no polling. Requests are synchronous round trips; a slow AI
operation holds the connection open for its full duration (measured: 77 s for a
450×250 crop at 4×).

**Contract sharing is one-directional and partial.** Python Pydantic models are
exported to JSON Schema (`packages/schemas/v1`) and then to TypeScript
(`packages/contracts-ts`), and CI fails on drift. **The workspace UI does not
import those TypeScript types** — it is plain JavaScript and reads the
catalogue at run time. The generated types are consumed only by `browser-lab`.

---

## 7. State management and canvas rendering

### State

A single module-level object in `app.js`:

```js
const state = {
  original,      // { dataUrl, bytes, name, type }  never mutated
  current,       // { dataUrl, object, width, height, bytes, mediaType }
  past: [],      // undo stack of previous `current` values
  applied: [],   // labels for the history strip
  catalogue, facts, busy, pendingJob, extraImages,
};
```

No framework, no store, no reactivity. Render functions (`renderFacts`,
`renderImages`, `renderTools`, `renderCanvasTools`) are called explicitly after
each mutation. **Nothing persists** — a page reload loses everything.

### Canvas

Not an HTML `<canvas>`. It is an `<img>` inside a CSS-transformed `<div>`:

```
.stage      fixed height, overflow hidden          ← the window
  .viewport transform: translate(x,y) scale(s)     ← pan and zoom
    img     natural size, max-width:none
```

Zoom is `view = { scale, x, y, fitted }` applied as a CSS transform. Range
0.05×–32×. Past 1× `image-rendering: pixelated` so artefacts are visible rather
than smoothed. Wheel zoom is anchored at the pointer. Crop is an overlay
rectangle held in **image coordinates** and drawn through the same transform.

---

## 8. Local versus cloud processing

**All processing is server-side Python. Nothing runs in the browser.**

The browser does exactly three things with pixels: display an image, draw the
crop overlay, and (in the preview path only) build a data URL.

`apps/browser-lab` exists to measure what a device *could* do locally — that is
open decision **O-003**, unresolved. No thresholds from it are wired into the
product.

"Local vs cloud" in this codebase means *where the server runs*, not a split
between browser and server.

---

## 9. File storage

`storage.py` defines a `Storage` protocol with two implementations:

| | `LocalStorage` | `GcsStorage` |
|---|---|---|
| Location | `data/local-storage/` | a GCS bucket |
| Download URL | `/api/downloads/local/<name>` served by this process | V4 signed URL |
| Upload URL | `/api/uploads/local/<name>` (PUT) | V4 signed URL |
| Credentials | none | service-account key via `GOOGLE_APPLICATION_CREDENTIALS` |

Selection is in `build_storage()`: a bucket **plus** usable credentials gives
GCS; a bucket without credentials falls back to local disk outside production
and raises in production.

Object names are `prefix/<random>-<original-name>` — the random component
prevents two customers' `scan.jpg` colliding.

**No lifecycle, retention or deletion policy exists.** Uploaded and processed
files accumulate indefinitely in `data/local-storage/` or the bucket.

---

## 10. Original-file preservation

* `state.original` is set once at load and never written to. Every operation
  reads `state.current` and produces a new value.
* Server-side, `guarded_process` copies the input into a temp workspace; the
  source path is never opened for writing.
* PDF operations rebuild the document rather than appending, so no
  incremental-update history is left behind.
* **Redaction deliberately destroys** the redacted text — that is the feature.
  The original file on the customer's disk is untouched, but the *returned*
  file has the text removed and unrecoverable (verified against the bytes).

---

## 11. Undo, redo and operation history

* `state.past` is a plain array; `undo()` pops one entry and restores it.
* `state.applied` holds labels, rendered as chips in a history strip.
* **There is no redo.** Nothing re-applies a popped entry.
* **The stack is unbounded** — every step keeps a full data URL in memory. Ten
  edits on a large image hold ten full copies.
* **History does not survive reload**, and is not written anywhere.
* Undo is not available in the PDF or batch views; those have their own
  separate, narrower undo (`pdf-undo`).

---

## 12. Models, adapters and external services

### Adapters that exist

| Adapter | File | Weights | Status |
|---|---|---|---|
| Real-ESRGAN ×2/×4 | `ai_adapters/real_esrgan.py` | `RealESRGAN_x2plus.pth`, `RealESRGAN_x4plus.pth` | works when weights installed |
| SwinIR (4 variants) | `ai_adapters/swinir.py` | 4 `.pth` files | works when weights installed |

Both verify a pinned SHA-256 **before** unpickling, and load with
`weights_only=True` so a checkpoint cannot execute code.

### Not implemented at all

`face_restore`, `damage_repair`, `colourise`, `background_remove`,
`background_replace` appear in the catalogue with `available: false`. **No
adapter exists** for any of them — the catalogue advertises capability the code
does not have. The UI hides them.

### External services

**None at run time.** No telemetry, no analytics, no third-party API. GCS is
reached only when a bucket and credentials are configured, and the V4 signing is
implemented by hand (no `google-cloud-storage` dependency).

---

## 13. Architectural decisions and assumptions

Recorded across 8 ADRs and ~90 entries in `docs/PRODUCT_DECISION_LOG.md`. The
load-bearing ones:

* **Determinism.** `random`, `datetime.now`, `time.time`, `uuid4` are banned
  repo-wide (enforced by TID251 lint) so runs are reproducible.
* **The standard baseline stays a plain imaging pipeline.** A test forbids
  numpy inside `packages/processors/src/ipw/processors/standard/`. This shaped
  real implementations — document cleanup, upscaling and perspective are all
  written in Pillow because of it.
* **Licence register before execution** (D-038). Every dependency and model has
  a recorded disposition with evidence read from the distributed artifact.
* **Two engines must agree.** Pillow and libvips are held to byte-identical
  behaviour where both implement an operation; where only one can, both call a
  shared implementation.
* **AI is opt-in and visibly marked** (D-007).
* **Nothing reports a state it was not given** — the UI never invents a number.

### Assumptions that are not enforced anywhere

* One user. There is no account, session or tenancy concept in any code path.
* One process. The LRU object cache and all state are per-process.
* Trusted input beyond format checks — no rate limiting, no auth, no quota.

---

## 14. Known limitations, defects and incomplete work

### Reported in the audit brief — investigated below in §16

### Structural

| | |
|---|---|
| **No persistence** | Postgres schema, migrations, job queue, worker and connection pool all exist and are tested, but **no UI feature reads or writes a row.** Close the tab and everything is lost. |
| **No authentication** | Anyone who can reach the port can use it. `config.py` refuses to bind off-loopback without `IPW_ALLOW_PUBLIC_BIND`. |
| **`server.py` is 2,000 lines** | One class holds every operation. |
| **Slow operations block** | 20–80 s round trips hold the connection. The queue that would fix this is built but unwired. |
| **Unbounded undo memory** | Full data URL per step. |
| **No lifecycle on stored files** | Uploads and results accumulate forever. |

### Advertised but absent

Five AI operations are in the catalogue with no implementation (§12).

### Model licensing — blocking commercial use

All six installed checkpoints have licence disposition **`unknown`**. Real-ESRGAN
and SwinIR weights derive from **DIV2K**, licensed *"academic research purpose
only"*. `licence_guard.py` refuses to start in production while they are
present. **AI upscaling cannot ship commercially as things stand.**

### CI

Ubuntu CI has **never been green**. `libvips` goldens fail there because the
goldens were generated against a different libvips build and the OS package is
not version-pinned. Windows CI passes. This predates the current work.

---

## 15. Unused, experimental or unreachable code

| Path | Status |
|---|---|
| `services/workspace-api/.../jobs.py`, `worker.py`, `handlers.py`, `pool.py` | **Built, tested, unreachable.** No route enqueues a job; no worker entry point exists in the Dockerfile. |
| `services/workspace-api/.../database.py` | Runs migrations at startup; **no feature uses the schema.** |
| `services/benchmark-runner/` (17 of 19 modules) | POC benchmark CLI. Not used by the application. |
| `apps/browser-lab/` | Measurement harness for an unresolved decision. Not the product. |
| `packages/contracts-ts/` | Generated types consumed only by `browser-lab`, not by the workspace UI. |
| `packages/metrics/` | PSNR/SSIM. Used by benchmark and by the upscaler's own tests; **not called at run time by the app.** |
| `#tools` element in `index.html` | Kept, empty and hidden, only because the command palette scrolls to it. Dead markup. |
| `apps/workspace/.../to_pdf`, `print_plan` | Reachable, but the print-plan panel is the only consumer. |

---

## 16. The seven reported issues — findings, not fixes

### 1. Editor canvas shows no visible image

**Root cause found, and it was fixed in commit `867c29b`, before this handoff.**

`.stage` had no height of its own, so it expanded to the image's natural size.
`zoomToFit()` then measured a stage that had already grown to fit the image and
returned a scale of 1 every time — the picture overflowed its container and the
zoom bar (revealed on the same code path) never appeared.

**Evidence that it is not a delivery or size problem:** a standalone probe page
rendering a 4960×4960 inline result reports `LOADED naturalWidth=4960
naturalHeight=4960 scale=0.121`. Large results load and render correctly.

**Residual risk not reproduced:** `renderImages()` has a `keepPlace` branch that
preserves `view.x/view.y` when an operation is applied while zoomed in. Those
offsets were computed for the previous image size. After an operation that
changes dimensions (enlarge, crop, straighten) the retained offset may place the
image outside the visible stage. **Not reproduced; needs interactive testing.**

### 2. Dimensions show 4960 × 4960 while megapixels show 1.05

**Confirmed. Two different sources, one stale.** `apps/workspace/app.js`
`renderFacts()`:

```js
["Size",       `${c.width} × ${c.height}`],   // state.current — updated after every edit
["Megapixels", f.megapixels],                 // state.facts   — captured once at upload
```

`state.facts` comes from `/api/inspect` at load time and is **never
recomputed**. After a 4× enlarge, Size reads the new dimensions and Megapixels
still reads the original. `Handling` (line 275) has the same defect. `Format`
and `File` correctly use `state.current`.

4960 × 4960 is 24.6 MP; 1.05 MP is roughly a 1025 × 1025 source.

### 3. Home page centred on document scanning

**Confirmed, and it is my doing.** The landing headline reads *"Make a
photograph of a document look like a scan"* and the four job cards are
document-oriented. This followed a direct instruction to make the document
workflow prominent and was not checked against the approved parent-product
module list. The catalogue still exposes all image, PDF, batch and vector
capability — **only the landing copy is narrowed.**

### 4. Tool actions are icon-only

**Confirmed by design, partially mitigated.** `renderCanvasTools()` emits icon
buttons with no visible text. Each carries `title` (native tooltip, name +
description), `aria-label`, and a CSS tooltip on hover/focus. **On first use
they are still unlabelled**, and the strip holds 13 icons in 5 groups separated
only by thin rules.

### 5. Download and Export overlap

**Confirmed — two different mechanisms with overlapping purpose.**

* **Download** (top bar, `download()`) writes `state.current.dataUrl` to disk in
  the image's current format. No options.
* **Export** (right panel tab) offers JPEG / PNG / PDF / SVG, re-processes
  server-side, and downloads the result.

Both end in a downloaded file. Nothing in the interface explains the
difference, and Download silently ignores the Export format choice.

### 6. Applied-operation history and undo unclear

**Confirmed.** The history strip shows labels only — no thumbnails, no
timestamps, no per-step revert. `undo()` pops exactly one step; **there is no
redo**; clicking a history chip does nothing. The strip is hidden until at least
one operation has been applied, so the mechanism is invisible to a first-time
user.

### 7. Hidden AI capabilities depend on uninstalled model files

**Confirmed, and worse than "uninstalled".** Two distinct cases:

* **Weights missing, adapter exists** — Real-ESRGAN, SwinIR. Installing the
  checkpoint makes them work.
* **No adapter at all** — `face_restore`, `damage_repair`, `colourise`,
  `background_remove`, `background_replace`. These are advertised in the
  catalogue and **can never work**, because nothing implements them. Installing
  weights would not help.

The UI hides both cases identically (`available === false`), so the catalogue
promises five capabilities that do not exist in code.

---

## 17. Security, privacy and licensing

### Security

* **No authentication or authorisation anywhere.**
* Bind is loopback-only unless `IPW_ALLOW_PUBLIC_BIND` is set — a deliberate
  guard, since the service is an unauthenticated image processor.
* Request bodies capped at 128 MB; decompression bombs refused at header
  inspection.
* Checkpoints verified by SHA-256 **before** unpickling, loaded with
  `weights_only=True`.
* `ImageMath.unsafe_eval` is used in three places on **fixed expression strings
  with image operands only** — no customer input reaches it. The name is alarming
  and warrants an auditor's eye even so.
* No rate limiting, no quota, no abuse controls.

### Privacy

* Processing is local to the server; no third-party service is contacted.
* **Uploaded files persist indefinitely** with no retention policy.
* Object names embed the original filename.
* No PII handling policy exists, though the product is explicitly aimed at
  medical and legal documents.
* Redaction is verified against the output bytes — a genuine strength.

### Licensing

* `data/licences/register.json` holds 52 components with recorded dispositions
  and read evidence.
* **Six installed model checkpoints are `unknown`.** They derive from DIV2K
  ("academic research purpose only"). Blocking for commercial use.
* Code licences for those models are `review_required`.
* Runtime Python dependencies are all approved permissive licences; a test
  asserts the declared set matches the approved set.

---

## 18. Environment variables

Names and meanings only — no values.

| Variable | Read by | Purpose |
|---|---|---|
| `IPW_ENV` | `config.py` | `local` \| `development` \| `staging` \| `production`. Controls strictness. |
| `IPW_BUCKET` | `config.py` | GCS bucket name, bare (no `gs://`). Empty ⇒ local disk. |
| `IPW_DATABASE_URL` | `config.py` | `postgresql://…`. Empty ⇒ nothing persists. |
| `IPW_HOST` | `config.py` | Bind address. Default `127.0.0.1`. |
| `IPW_PORT` | `config.py` | Bind port. Default `8770`. |
| `IPW_ALLOW_PUBLIC_BIND` | `config.py` | Must be set before binding off loopback. |
| `PORT` | `config.py` | Cloud Run's port; takes precedence over `IPW_PORT`. |
| `GOOGLE_APPLICATION_CREDENTIALS` | `storage.py` | Path to a service-account key. Absent ⇒ local storage outside production. |
| `K_REVISION` | `worker.py` | Cloud Run revision, used only to name a worker. |
| `COVERAGE_RCFILE` | CI only | Selects `.coveragerc-ci`. |

`.env.example` documents `IPW_ENV`, `IPW_BUCKET`, `IPW_DATABASE_URL`.
`config.py` validates the database URL and bucket name shape and reports
problems at startup rather than failing later.

---

## 19. Verification run for this handoff

Commands run without modifying code. Full detail in `LOCAL_RUNBOOK.md`.

| Check | Command | Result |
|---|---|---|
| Format | `python -m ruff format --check .` | **183 files already formatted** |
| Lint | `python -m ruff check .` | **All checks passed** |
| Types | `python -m mypy .` | **no issues in 156 source files** |
| Python tests | `python -m pytest` | **1703 passed, 1 skipped**, coverage **90.01%** |
| Node tests | `npm test` | **22 passed, 0 failed** |
| All gates | `python tools/check.py` | **all 16 gates passed** |

Every gate passes on this machine (Windows, Python 3.14, libvips present via
`.tools/`, model weights present). **Ubuntu CI does not pass** — see §14.

---

## 20. Assessment

### Genuinely reusable

* **`packages/pdf`** — reader, writer, redaction, OCR text layer, compression,
  Bates numbering. Redaction is verified against output bytes and has a
  regression test for the leak found on 27 Aug.
* **`packages/processors/standard`** — the imaging engines and the four
  document algorithms (illumination correction, back-projection upscaling,
  perspective correction, tile planning). Each is measured against ground truth,
  not asserted.
* **`packages/contracts`** + schema/TypeScript generation with drift checks.
* **`packages/vector`**, **`packages/metrics`**.
* **`storage.py`** — hand-rolled GCS V4 signing, tested against a real bucket.
* The licence register and its enforcement.

### Experimental

* `apps/browser-lab` — harness for an unresolved decision.
* `services/benchmark-runner` — POC infrastructure; two modules leaked into the
  application.
* `jobs.py` / `worker.py` / `handlers.py` / `pool.py` — production-intent code
  with no consumer.

### Likely needs redesign

* **`server.py`** — 2,000 lines, one class, every operation.
* **Front-end state** — module-global object, manual renders, no persistence, no
  redo, unbounded undo memory.
* **Synchronous processing** — 20–80 s requests block; the queue exists but is
  not wired.
* **The catalogue's relationship to reality** — it can advertise operations no
  code implements.

### Unsafe or unknown

* **Model weight licensing** — `unknown`, DIV2K-derived, blocks commercial sale.
* **No authentication** on a service that accepts and stores customer files.
* **No retention policy** for uploaded medical and legal documents.
* **Ubuntu CI has never passed**, so cross-platform behaviour is unverified.
* **The React/Node assumption in the audit brief** does not match this
  repository.

### Questions the next team must answer

1. Is the audit brief describing this repository? There is no React here.
2. Will the business buy a commercial SR model licence, take legal advice on
   DIV2K-derived weights, or ship only the classical path?
3. Should the five unimplemented AI operations be removed from the catalogue or
   built?
4. What is the retention and deletion policy for uploaded documents?
5. Is the document-scanning emphasis on the home page correct, or should the
   parent product modules lead?
6. Should the job queue be wired, or removed as speculative?
7. Who owns the libvips golden-file problem that keeps Ubuntu CI red?
8. What is the intended multi-user model? Nothing in the code anticipates one.
