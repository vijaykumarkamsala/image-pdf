# ADR-0004 — Imaging libraries, and the LGPL condition on native distribution

**Status:** Accepted, with one deferred re-review
**Date:** 24 August 2026
**Task:** POC-004
**Decisions recorded:** D-045, D-046, D-047

---

## Part 1 — Both engines (D-045)

POC-004 needs a real decoder. Two candidates entered the register together rather
than one, so the deterministic baseline itself carries a performance comparison.

| | Pillow 12.3.0 | libvips 8.18.5 (via pyvips 3.1.1) |
|---|---|---|
| Licence | MIT-CMU (HPND) | LGPL-2.1-or-later (binding is MIT) |
| Obligations | notice retention | notice, relink, source availability **on distribution** |
| Install | wheel, nothing else | native library from a package manager or `tools/install_libvips.py` |
| Architecture | eager, whole-image buffers | demand-driven, streaming |

**First measurement**, a 64×64 Lanczos resize on this machine:

| Engine | Output | Peak memory |
|---|---|---|
| Pillow | 280 B | 1.43 MB |
| libvips | 2435 B | **0.08 MB** |

Roughly 17× less memory at a size where it should not yet matter. That gap is the
reason both are here: POC-012's tiling and the 100 MB professional path will live
or die on it, and now it is measured rather than assumed.

Different byte output is expected, not a defect — different resampling
implementations and different encoders. Each engine owns its own goldens.

### Consequences

The runtime licence register grew from one entry to three (plus two transitive
dependencies of pyvips). Every one has a real review with evidence pointing at the
licence text that was read.

Pillow's C decoders have a non-trivial CVE history, since they parse untrusted
input. Materially mitigated by work already done: POC-003's header-first
inspection rejects bombs and malformed files **before** Pillow sees them, the
version is pinned, `MAX_IMAGE_PIXELS` is set, and POC-006 adds container
isolation.

## Part 2 — Exact-hash goldens (D-046)

Golden comparison is exact SHA-256, not pixel tolerance.

A tolerance survives library patch releases quietly, which sounds convenient until
you notice it also survives a genuine resampling regression of the same magnitude —
and detecting exactly that is what this benchmark exists for. With versions pinned,
any byte change is either a deliberate upgrade or a defect, and both deserve to
stop the build.

The cost is that a version bump becomes a deliberate, reviewed step:

1. Bump the version in the workspace `pyproject.toml` and the licence register.
2. `python tools/make_goldens.py --check` reports which operations moved.
3. Regenerate, then **look at the images**, not only the hashes.
4. Record the visual assessment in the task report before committing.

That is the correct behaviour for a benchmark baseline. Silent drift in a
measuring instrument is worse than a failing build.

## Part 3 — The LGPL condition (D-047)

**libvips is commercially usable for the web product. It carries a condition that
changes if a native application ever ships.**

### The analysis

LGPL-2.1 obligations attach on **distribution** of the software. A hosted service
distributes no binaries to customers: users interact with a web application over
HTTP and never receive libvips. The practical duties are therefore notice and
attribution, and because the library is dynamically linked, our own source is
unaffected — that is precisely the distinction the LGPL exists to draw.

Recorded in the register as `required_notices`:

- provide the LGPL-2.1 licence text with any distribution;
- state that libvips is used and may be modified and relinked;
- make the libvips source available, or point to the upstream repository.

### Where it changes

`MASTER_PRODUCT_BLUEPRINT.md` §23 keeps native desktop and mobile applications
open as a later option, and `PRODUCT_REQUIREMENTS.md` §5.4 lists them under later
releases. **If a native application ships libvips to end users, the relink and
source-availability duties genuinely apply**, because that is distribution.

That is not a blocker and not a reason to avoid libvips now. It is a condition
worth knowing before the library becomes load-bearing in a place that is expensive
to change.

### The decision

Approve libvips for server-side use, with a **mandatory re-review before any
native desktop or mobile application is distributed**. Three things make that
re-review hard to forget rather than dependent on someone remembering:

1. The register entry carries the condition in its `notes`, and the register is
   summarised in every generated benchmark report.
2. The obligations are enumerated in `required_notices`, so an attribution page
   can be generated from the register rather than hand-written.
3. Pillow remains the primary engine and the D-040 approved fallback for every
   standard operation. If the native-app analysis ever turns unfavourable, libvips
   can be dropped without leaving an operation unserved — which is exactly the
   protection D-040 was written to provide, now doing real work.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Pillow only | Gives up the memory profile that POC-012 depends on, and would have to be revisited under time pressure when large-image work starts. |
| libvips only | Concentrates the whole standard path on the licence with conditions, and removes the fallback that makes the condition survivable. |
| Wait for the native-app decision | It is years away and may never come. Deferring a measurement that is cheap now, to avoid a condition that may never trigger, is the wrong trade. |

---

## Related

- `docs/adr/ADR-0002-monorepo-and-licence-gates.md` — D-039 Gate B, which libvips passed through
- `docs/adr/ADR-0003-header-first-inspection.md` — the inspection that runs before any decoder
- `docs/PRODUCT_DECISION_LOG.md` — D-021, D-022, D-040
- `MASTER_PRODUCT_BLUEPRINT.md` §23 — native applications as a later option
- `data/licences/register.json` — the authoritative record, including required notices
