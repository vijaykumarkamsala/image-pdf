# Local runbook

Prepared 28 August 2026 at commit `2cd007a` (tag `handoff-audit-2026-08-28`).
Every command below was run on the machine described here and the output is
transcribed, not reconstructed. Nothing was modified to make anything pass.

---

## 1. Software versions

Verified on this machine:

| Tool | Version | How checked |
|---|---|---|
| OS | Windows 11 Enterprise 10.0.26100 | — |
| Python | **3.14.5** | `.venv/Scripts/python.exe -V` |
| Node | **v24.16.0** | `node -v` |
| npm | **11.15.0** | `npm -v` |
| ruff | **0.16.4** | `python -m ruff --version` |
| mypy | **2.3.1** (compiled) | `python -m mypy --version` |
| pytest | **9.1.1** | `python -m pytest --version` |
| TypeScript | 5.9.3 | `package.json` devDependencies |
| Pillow | 12.3.0 | reported in an operation response |
| Tesseract | **5.4.0.20240606** at `C:/Program Files/Tesseract-OCR/tesseract.exe` | `/api/ocr-availability` |

`pyproject.toml` sets `target-version = "py311"` for ruff, so 3.11 is the floor
the linter assumes. The environment in use is 3.14.5. That gap has not been
tested at 3.11.

**Optional, not present on this machine:** libvips (installed via
`tools/install_libvips.py`), Docker, PostgreSQL.

---

## 2. Install

### 2.1 The command the README gives

`README.md` lines 29–31:

```powershell
python -m pip install -c requirements-dev.lock.txt -r requirements-dev.txt `
  -e packages/contracts -e packages/processors -e services/benchmark-runner
```

### 2.2 That command is incomplete — see §9.1

Three editable packages are listed. **Seven are actually installed** in the
working `.venv`:

```
__editable__.ipw_contracts-0.1.0.pth
__editable__.ipw_processors-0.1.0.pth
__editable__.ipw_benchmark_runner-0.1.0.pth
__editable__.ipw_metrics-0.1.0.pth
__editable__.ipw_pdf-0.1.0.pth
__editable__.ipw_vector-0.1.0.pth
__editable__.ipw_workspace_api-0.1.0.pth
```

The install that actually reproduces this environment:

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -c requirements-dev.lock.txt -r requirements-dev.txt `
  -e packages/contracts -e packages/processors -e packages/metrics `
  -e packages/pdf -e packages/vector `
  -e services/benchmark-runner -e services/workspace-api
```

```powershell
npm install          # 2 workspaces: packages/contracts-ts, apps/browser-lab
```

### 2.3 Optional components

```powershell
python tools/install_libvips.py          # downloads libvips (network)
python tools/install_model_weights.py    # downloads AI weights (network) — read §8 first
python tools/install_model_weights.py --verify   # check digests without downloading
```

---

## 3. Environment variables

The application starts with **none set**. Defaults come from
`services/workspace-api/src/ipw/workspace_api/config.py`.

| Variable | Effect if unset |
|---|---|
| `IPW_ENVIRONMENT` | `local`. Set to `production` to make the licence guard and the database check fatal rather than warnings. |
| `IPW_BUCKET` | Unset → results are written under `data/local-storage/` instead of GCS. |
| `IPW_DATABASE_URL` | Unset → the migration step is skipped with a warning locally. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Unset → signed uploads are unavailable; the UI falls back to inline base64. |

There is no `.env` file in the repository and none is tracked. Confirm with
`git ls-files | Select-String "\.env"` — no result.

---

## 4. Run

### 4.1 The product

```powershell
.venv\Scripts\python.exe tools\serve_workspace.py
```

Serves the interface and the API from one origin on **port 8770**. Opens a
browser; `--no-browser` suppresses that; `--port N` changes the port.

**This is the only way the product runs.** There is no Docker image built, no
`uvicorn`/`gunicorn`, no process manager. The server is Python's stdlib
`http.server`.

### 4.2 The benchmark harness — not the product

```powershell
bench --help
python -m ipw.benchmark_runner --help
```

### 4.3 The browser measurement lab — not the product

```powershell
.venv\Scripts\python.exe tools\serve_browser_lab.py     # port 8173
```

A measurement page for deciding what a browser can do. It is not a feature and
is not linked from the product.

### 4.4 Not runnable here

- **Worker** — `worker.py` exists and is tested, but has no entry point in the
  Dockerfile and nothing enqueues work. There is no command that starts it.
- **Container** — the `Dockerfile` has never been built (no Docker installed).
- **Cloud Run** — `deploy/README.md` documents it; it has never been executed.

---

## 5. Ports and health checks

| Port | Serves | Started by |
|---|---|---|
| **8770** | product UI + API (one origin) | `tools/serve_workspace.py` |
| 8173 | browser measurement lab | `tools/serve_browser_lab.py` |

### Health check — real output from this machine

```
$ curl -s http://127.0.0.1:8771/api/health
{"ok": true, "service": "workspace-api", "environment": "local", "warnings": []}
```

```
$ curl -s http://127.0.0.1:8771/api/ocr-availability
{"ok": true, "available": true, "reason": "",
 "binary": "C:/Program Files/Tesseract-OCR/tesseract.exe",
 "version": "tesseract v5.4.0.20240606",
 "licence_note": "Tesseract is recorded in the licence register as review_required..."}
```

(Port 8771 was used to avoid disturbing anything on the default 8770.)

Twenty-three API routes are registered; `GET /api/catalogue` returns the
operation list and is the quickest way to see what the server believes it
offers.

---

## 6. Format, lint, type check, test

Run individually — **transcribed output, 28 August 2026**:

```
$ .venv/Scripts/python.exe -m ruff format --check .
183 files already formatted                       exit 0

$ .venv/Scripts/python.exe -m ruff check .
All checks passed!                                exit 0

$ .venv/Scripts/python.exe -m mypy
Success: no issues found in 156 source files      exit 0

$ .venv/Scripts/python.exe -m pytest -q
1703 passed, 1 skipped
TOTAL 10136 stmts, 824 miss, 2800 branch, 352 partial, 90%
Required test coverage of 90% reached. Total coverage: 90.01%
                                                  exit 0

$ npm test
tests 22 · pass 22 · fail 0                       exit 0

$ npm run typecheck
tsc --noEmit (both workspaces)                    exit 0
```

Or all of it at once:

```
$ .venv/Scripts/python.exe tools/check.py
PASS  format                      0.4s
PASS  lint                        0.3s
PASS  types                       1.8s
PASS  tests                     378.2s
PASS  fixture-integrity           0.7s
PASS  fixture-reproducibility     0.3s
PASS  inspection-fixtures         0.3s
PASS  ts-contract-drift           0.7s
PASS  canonical-vectors           0.6s
PASS  ts-typecheck                5.4s
PASS  ts-tests                    4.3s
PASS  goldens                     1.7s
PASS  schema-drift                1.1s
PASS  licence-register            0.8s
PASS  model-weights               1.2s
PASS  example-manifest            0.9s

all 16 gates passed                               exit 0
```

`tools/check.py --list` explains each gate. `--fix` formats first.

### What these checks do NOT cover

`ruff` excludes `apps` (`pyproject.toml:32`). The npm workspaces are
`packages/contracts-ts` and `apps/browser-lab` only — **`apps/workspace` has no
`package.json`**, so it is not a workspace, not type-checked and not tested.

| Product UI file | Lines | Linted | Typechecked | Tested |
|---|---|---|---|---|
| `apps/workspace/app.js` | 1,892 | no | no | no |
| `apps/workspace/pdf-view.js` | 795 | no | no | no |
| `apps/workspace/batch-view.js` | 694 | no | no | no |
| `apps/workspace/styles.css` | 1,842 | no | no | no |
| `apps/workspace/index.html` | 477 | no | no | no |

**5,700 lines of the product's entire user interface have no automated check of
any kind.** The 22 passing JavaScript tests belong to the TypeScript contracts
package and the measurement lab, not to the product.

---

## 7. Reproducing the interface

### 7.1 Home page

1. `.venv\Scripts\python.exe tools\serve_workspace.py`
2. Open `http://127.0.0.1:8770/`

You will see the headline **"Make a photograph of a document look like a scan"**
and four job cards. This is **reported issue 3**: the page presents a
document-scanning tool rather than the approved parent-product modules. It is
what the code renders; `apps/workspace/index.html` contains the wording.

### 7.2 Editor

Drop any JPEG or PNG onto the home page, or use Browse. The editor replaces the
landing view: canvas centre, icon tool strip, facts panel right.

### 7.3 Issue 2 — dimensions and megapixels disagree

1. Load an image.
2. Apply **Enlarge** or **Resize** to change its size.
3. Read the facts panel.

**Size** updates; **Megapixels** and **Handling** do not. In `app.js`,
`renderFacts()` reads `state.current.width/height` for Size but
`state.facts.megapixels` and `state.facts.decision` for the other two, and
`state.facts` is captured once at upload and never recomputed. Reported at
4960 × 4960 with 1.05 MP, which is the megapixel count of the *original*.

### 7.4 Issue 5 — Download and Export overlap

The top bar **Download** hands back `state.current.dataUrl` unchanged. The
**Export** panel re-processes through `/api/process` and honours the chosen
format and quality. Two buttons, two different results, no indication which is
which.

### 7.5 Issue 6 — history and undo

Apply two or more operations. The history list shows labels only — no
thumbnails, no timestamps, no per-step revert, and the chips are not clickable.
**Undo** steps back one at a time. **There is no redo**, and the whole stack is
lost on reload.

### 7.6 Issue 4 — icon-only tools

The canvas tool strip is icons. Each carries `title` and `aria-label` and a CSS
tooltip, so hovering names the tool, but nothing is labelled at rest.

---

## 8. Reproducing the blank canvas (issue 1)

**This defect is fixed at the audited commit.** To see it, check out the parent
of the fix:

```powershell
git stash                       # if you have local changes
git checkout 95fbf88            # parent of the fix
.venv\Scripts\python.exe tools\serve_workspace.py
# load a large image — 4960 x 4960 reproduces it reliably
git checkout main
```

**Root cause.** `.stage` had no height of its own, so it grew to the image's
natural size. `zoomToFit` then measured a stage that had already grown to fit
the image and returned a scale of 1 every time. The picture overflowed its
container, the zoom bar never appeared, and it read as a broken canvas when the
arithmetic was correct and the box was wrong.

**The fix** is commit `867c29b`, "Look at the interface, then fix what is wrong
with it" — an ancestor of the audited commit. It adds:

```css
.stage {
  height: clamp(420px, calc(100vh - 250px), 900px);
  min-height: 0;
  display: block;
  padding: 0;
}
```

**How the fix is applied matters, and it is fragile.** `styles.css` is 1,842
lines and declares `.stage` **three times** — at lines 407, 1490 and 1775. The
base rule at 407 still says `min-height: 380px; display: grid; padding: 20px`.
The fix at 1775 wins only by being later in the file. Reordering, splitting or
bundling the stylesheet re-introduces the defect with no test to catch it.

**Verification that the canvas now renders.** A probe page loading a 4960 × 4960
inline result reported `LOADED naturalWidth=4960 scale=0.121` — the image
decodes and the fit arithmetic is correct.

**Residual, not reproduced.** The `keepPlace` path retains `view.x/y` across an
operation. After an operation that changes the image's size, a retained offset
can place the image outside the visible stage. This was not reproduced during
the audit and is recorded as a suspicion, not a finding.

---

## 9. Testing one standard and one AI operation

Both were run against a live server on this machine. Payload shape is flat:
`{operation, settings, image, filename}`.

### 9.1 Standard — resize

```
POST /api/process
{"operation": "resize",
 "settings": {"target_width": 256, "target_height": 256, "algorithm": "lanczos"},
 "image": "data:image/png;base64,...",
 "filename": "synthetic-gradient-64.png"}
```

Response, HTTP 200 in 0.22 s:

```json
{"ok": true, "bytes": 2630, "delivery": "inline",
 "width": 256, "height": 256, "media_type": "image/png",
 "sha256": "558666db61f39bf9494b74264fdeb512b7b2501f42f996d487b420e5c4fff39a",
 "processor": {"name": "standard-pillow", "family": "standard",
               "used_a_model": false, "weights": null},
 "took_ms": 131, "notes": "pillow 12.3.0"}
```

Passing `width`/`height` instead of `target_width`/`target_height` returns a
helpful 400 that lists the accepted settings — worth noting, because the API
refuses clearly rather than guessing.

### 9.2 AI — super-resolution ×2

```
POST /api/process
{"operation": "super_resolution", "settings": {"scale": 2}, "image": "...", ...}
```

Response, HTTP 200 in 5.7 s:

```json
{"ok": true, "bytes": 28056, "width": 128, "height": 128,
 "processor": {"name": "real-esrgan-x2", "family": "ai",
               "used_a_model": true, "weights": "RealESRGAN_x2plus.pth"},
 "took_ms": 5556,
 "tiling": {"tile_size": 64, "columns": 1, "rows": 1, "tile_count": 1,
            "reason": "whole_image", "exceeds_budget": false, "scale": 2},
 "notes": "native x2, fp32, tile 64/0 x1 (whole_image), backend cpu"}
```

**This worked because weights are present on this machine.** Six `.pth` files
sit in `.tools/models/` — gitignored, so a fresh clone has none:

```
RealESRGAN_x2plus.pth
RealESRGAN_x4plus.pth
003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x2_GAN.pth
003_realSR_BSRGAN_DFO_s64w8_SwinIR-M_x4_GAN.pth
005_colorDN_DFWB_s128w8_SwinIR-M_noise15.pth
006_colorCAR_DFWB_s126w7_SwinIR-M_jpeg10.pth
```

**Do not download these for a commercial evaluation without reading the register
first.** All six are `unknown` disposition in `data/licences/register.json`.

### 9.3 Issue 7 — hidden AI capabilities

`GET /api/catalogue` returns **20 operations**: 12 standard and 8 AI.

| AI operation | available | Why |
|---|---|---|
| `super_resolution` | **true** | adapter + weights present |
| `ai_denoise` | **true** | adapter + weights present |
| `jpeg_artifact_repair` | **true** | adapter + weights present; `advertised: false` but the UI ignores that flag |
| `face_restore` | false | **no adapter exists** |
| `damage_repair` | false | **no adapter exists** |
| `colourise` | false | **no adapter exists** |
| `background_remove` | false | **no adapter exists** |
| `background_replace` | false | **no adapter exists** |

The five unavailable ones are not a missing-weights problem. There is no adapter
file for any of them — installing weights would change nothing.

---

## 10. Known setup failures

### 10.1 Following the README exactly gives a half-broken app

The README installs three editable packages. `serve_workspace.py` adds four
`src` directories to `sys.path` — `workspace-api`, `contracts`, `processors`,
`benchmark-runner` — and **not** `packages/pdf/src`, `packages/vector/src` or
`packages/metrics/src`. Demonstrated on this machine with `python -S` (which
skips the editable `.pth` finders) and the four paths `serve_workspace.py` adds:

```
ipw.contracts        importable
ipw.processors       importable
ipw.workspace_api    importable
ipw.pdf              NOT IMPORTABLE
ipw.vector           NOT IMPORTABLE
ipw.metrics          NOT IMPORTABLE
```

Every `ipw.pdf` import in `server.py` is **deferred inside a method** (lines 904,
999, 1069, 1108, 1224 …), so the server starts cleanly and the home page loads.
It fails on the first PDF or vector request. Use the install in §2.2.

### 10.2 libvips is optional and usually absent

Without it the Pillow engine is used. Nothing fails, but `vips_engine.py` (67%)
and `vips_runtime.py` (77%) — the lowest coverage in the application — are never
exercised. CI does not have libvips either.

### 10.3 Tesseract is required for OCR and is not on CI

Present here (5.4.0). Absent on CI deliberately: the pinned tessdata cannot be
fetched under the scope guard, so `ocr.py` is excluded from the CI coverage
configuration (`.coveragerc-ci`). Check with `/api/ocr-availability` before
reporting an OCR bug.

### 10.4 The port is not released promptly on Windows

`pkill` does not work here. Kill by port:

```powershell
Get-NetTCPConnection -LocalPort 8770 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

A stale server is the reason two earlier "verified" fixes in this repository's
history were verified against old code. If a change does not appear, confirm the
process was actually restarted before investigating anything else.

### 10.5 No database, and that is fine locally

With `IPW_DATABASE_URL` unset the migration step is skipped with a warning. In
`production` it is fatal. An earlier change made the check fatal everywhere and
broke local startup; it was corrected.

### 10.6 The full suite is slow

`pytest` takes ~378 s of the 400 s `tools/check.py` run, dominated by the AI
adapter tests. For a quick loop, run a single file:
`python -m pytest packages/pdf/tests/test_redact.py`.

### 10.7 Python version gap

ruff targets py311; the environment is 3.14.5. Nothing has been run at 3.11.

---

## Closing assessment

### Genuinely reusable

`tools/check.py` — sixteen gates, each with a stated reason, one command, honest
exit codes, all passing. The API's refusal behaviour: wrong settings produce a
400 that names the accepted fields rather than a stack trace. `/api/health` and
`/api/ocr-availability` report real state including the licence caveat.

### Experimental

`tools/serve_browser_lab.py` and everything it serves — a measurement harness.
The `bench` CLI. The AI path runs, but on weights that cannot be licensed.

### Needs redesign

The install story: the README's command does not reproduce a working
environment, and `serve_workspace.py` compensates for some missing packages but
not others, so the failure is deferred to the first PDF request instead of
being caught at startup. The stylesheet, where the canvas fix survives only by
cascade position among three `.stage` declarations. Startup lives in `http.py`
while the file called `server.py` is the service — the names are the wrong way
round.

### Unsafe or unknown

- **5,700 lines of product UI with no lint, no typecheck and no tests.** Every
  interface defect in this handoff was found by screenshotting a running page.
- **Six AI weight files on this machine, all `unknown` disposition.**
  `tools/install_model_weights.py` is how they arrive; read the register first.
- **No authentication.** Every route is open to any caller.
- **stdlib `http.server`** is the production server. It is single-threaded and
  was not written for untrusted traffic.
- **The container has never been built**; deployment has never been run. Nothing
  in this runbook has been exercised outside this one Windows machine.

### Questions for the next team

1. Should `apps/workspace` become an npm workspace so the interface gets a
   linter and a test runner at all?
2. Should `serve_workspace.py` fail loudly at startup when `ipw.pdf` is
   unimportable, rather than at the first PDF request?
3. Which Python version is the target — 3.11 as ruff assumes, or 3.14 as used?
4. Is libvips a supported configuration? It is optional, absent from CI, and
   carries the least-tested code in the application.
5. What is the intended production server? `http.server` will not do.
