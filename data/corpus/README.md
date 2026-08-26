# Evaluation corpus intake

Where your real images go, and what has to be recorded about them before they can
be benchmarked.

Nothing here is committed. Images live in protected storage; Git holds only the
manifest, the asset ids and the hashes. That is not a POC rule — it is how the
production asset model works (`PRODUCT_REQUIREMENTS.md` §8), so the manifest you
fill in now is the same shape production will read.

---

## Why this matters more than it sounds

Everything built so far measures the *machinery*: contracts, gates, inspection,
two processing engines with byte-exact goldens. All of it runs against a 64×64
synthetic gradient.

That gradient cannot tell you whether Real-ESRGAN is any good on a customer's
faded 1970s photograph. Model selection (open decision **O-002**) is the single
biggest thing the POC exists to answer, and it stays unanswerable until real
images arrive. Benchmark plan §18 says the same: *"product-owner samples are
required before a production decision."*

## What to send

Roughly 20–30 images is enough to start; ~200 for a release decision. Spread
across the categories in benchmark plan §5.1 — the manifest validates against
these exact values:

| Category | Why it is a distinct category | Target |
|---|---|---:|
| `old_photograph` | fading, scratches, folds, monochrome — the restoration case | 5–8 |
| `face_portrait` | identity preservation is a critical-failure dimension | 5–8 |
| `document_screenshot` | text and logos must survive; a "sharper" invented glyph is a failure | 3–5 |
| `modern_mobile_photo` | the common case: compression, motion, mixed lighting | 3–5 |
| `product_catalogue` | edges, labels, textures, transparency | 3–5 |
| `low_light_noisy` | separates genuine denoise from detail destruction | 2–4 |
| `large_professional` | exercises the 25 MB / 100 MB tiers and tiling | 2–3 |

Send them however is convenient. Originals, not exports — a re-compressed JPEG
measures the re-compression, not the model.

## What must be recorded per image

Four rights questions. They are not paperwork: **the answers change what the
system will let you do.**

| Field | What it controls |
|---|---|
| `permitted_benchmark_use` | `false` blocks the asset from every run, at any purpose |
| `public_demo_permitted` | `false` blocks it from a `public_demo` run — an approved model still cannot display it |
| `contains_people` | recorded for review; drives handling policy |
| `contains_sensitive_information` | warns for research, **blocks** every commercial purpose |

Plus `source`, `owner` and `licence` — who it came from and under what permission.

A one-line answer per image is enough; the manifest can be generated from it.

## The one thing worth deciding up front

**May results appear publicly?** Benchmark plan §18 asks explicitly. It is worth
answering per-image rather than globally, because the honest answer usually
differs: family photographs almost never, product shots usually yes.

The gate already enforces whatever you decide — an asset marked
`public_demo_permitted: false` is refused from a `public_demo` run even when
every model in the pipeline is fully approved.

## Layout

```text
data/corpus/
  README.md              this file
  corpus.manifest.json   the manifest (tracked). Asset ids and hashes only.
  images/                YOUR IMAGES — gitignored, never committed
```

## Steps

```powershell
# 1. Drop the images into data/corpus/images/ (gitignored).

# 2. Draft manifest entries from what is on disk. Reads headers only,
#    fills in dimensions, depth, channels and SHA-256, and leaves the rights
#    fields blank for you to answer.
python tools/draft_corpus_manifest.py

# 3. Answer the rights questions in the generated manifest.

# 4. Validate. Missing provenance fails; it is not optional.
bench validate-manifest data/corpus/corpus.manifest.json

# 5. Inspect. Confirms formats, dimensions and handling tier before any run.
bench inspect data/corpus/images/*
```

Step 2 never decodes an image — the same header-first inspection used everywhere
else, so an oversized or malformed file is reported rather than loaded.

## What happens if a field is left blank

Validation fails with `MANIFEST.MISSING_PROVENANCE` and names the field. That is
deliberate: an asset with unknown rights is not "probably fine", and the system
declines to guess on your behalf.
