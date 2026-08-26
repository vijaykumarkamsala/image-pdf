# ADR-0007 — Blinding a human instrument

**Status:** Accepted
**Date:** 25 August 2026
**Task:** POC-008
**Decisions recorded:** D-061, D-062, D-063, D-064

---

POC-007 ended by refusing to declare a winner from PSNR and SSIM, and pointing at
this task. So this is where the quality question is actually answered — which
makes the review workflow a *measuring instrument*, and an instrument needs the
same care about bias that a numerical one needs about calibration.

## Part 1 — Blinding is not filenames (D-061)

The acceptance criterion says reviewers must not infer model identity from
filenames or UI. Taking that literally would have produced a workflow that fails
in practice, because a filename is only one of several channels that correlate
perfectly with the producer.

| channel | closed by |
| --- | --- |
| filename | opaque `item-NN` labels |
| directory layout | one flat directory, no per-model folders |
| ordering | keyed shuffle, seed sealed |
| **file size** | **re-encode, then pad to a common size** |
| image metadata | re-encode, ancillary chunks dropped |

**File size would have quietly defeated the whole exercise.** On the real POC-007
comparison the three candidates wrote 2,630, 83,125 and 87,651 bytes. Any file
browser with a size column tells the reviewer which item is the deterministic
baseline before they open a single image — and the baseline is exactly what
"preference over the standard baseline" asks them to judge against blind.

Padding uses a private, ancillary PNG chunk (`ipWd`), which every decoder skips.
After blinding, all three files are 87,663 bytes and decode identically. A test
asserts both halves: that the blinded files are the same size, *and* that the
source files were not — otherwise the first assertion would pass for the wrong
reason forever.

**What blinding cannot defeat, stated rather than hidden.** The images differ,
which is the point. A reviewer may well guess which item is the deterministic
control from its softness. What they cannot do is distinguish Real-ESRGAN from
SwinIR — the comparison that actually matters — or map any item to a run. That
residual channel is documented in the module rather than left for someone to
discover and lose confidence over.

## Part 2 — Two identifiers, because one cannot do both jobs (D-062)

Blinding and traceability pull in opposite directions: reviewers must learn
nothing, and every score must attribute to an exact run, processor version and
weight digest.

The resolution is two identifiers. `ReviewItem.label` is what the reviewer sees
and carries no information. `SealedEntry` holds the provenance in a separate
document.

**A digest would have looked opaque and been trivially reversible.** Deriving the
label from `sha256(run_id)` is the obvious idea and it is wrong here: there are
three candidates, so anyone with the run documents brute-forces every label in
milliseconds. The ordering therefore comes from a *keyed* shuffle whose seed lives
in the sealed half, so the visible half contains nothing to attack.

`random` is banned repository-wide — a benchmark whose ordering depends on ambient
state is not reproducible — and it is not needed: sorting by `sha256(seed ‖ key)`
is a permutation, reproducible from the seed and unguessable without it. Tests
assert both properties.

**The CLI refuses to write the sealed key inside the package directory**, before
it reads or writes anything. Refusing on the *argument* rather than the outcome
matters: a key written and then moved has already been in the package directory,
and "only for a moment" is not a property anyone can verify afterwards.

## Part 3 — Critical failures are a channel, not a low score (D-063)

Benchmark plan section 8.3 lists eight conditions that fail a result outright. The
tempting implementation folds them into the score — a critical failure costs three
points, say — and it is wrong, because a mean is precisely the operation that lets
an appealing result outvote its own unacceptability.

A changed digit on an invoice is not "3 out of 5 on text accuracy". It is
unusable, and no amount of attractiveness elsewhere redeems it.

So the aggregation keeps them separate and dominant, and **one reviewer raising
one failure is enough**. A second opinion that the image looks lovely does not
make the digit correct.

The first real run demonstrates it exactly:

| item | mean score | failed | needs third review |
| --- | ---: | --- | --- |
| item-01 | 3.38 | no | no |
| **item-02** | **4.62** | **YES** | yes |
| item-03 | 3.25 | no | yes |

**The highest-scoring item is the failed one.** It scored 5/5/5/4 from one
reviewer and 5/4/5/4 from the other, and one of them noticed a changed digit.
Under any averaging scheme it would have won.

**Disagreement is surfaced, not averaged.** Two reviewers who differ by the tie
threshold (2) on overall usefulness, or who disagree about *any* critical failure,
mark the item for a third review. Averaging 2 and 4 into 3 manufactures a
consensus that does not exist — item-03 above is that case.

**Items nobody scored are reported.** A silently dropped item looks identical to
an item nobody objected to.

## Part 4 — Sums and counts, never a stored mean (D-064)

`ItemVerdict` records `score_sum` and `score_count`; the mean is a derived
property for display. A committed artifact that holds a float invites drift that
has nothing to do with the thing being measured — the same reasoning that makes
`canonical.py` reject floats outright, applied to a document that is compared and
diffed rather than digested.

A test asserts no float reaches the serialised summary.

## Consequences

- Contract **1.3.0 → 1.4.0**, additive: `ReviewPackage`, `SealedKey`,
  `ReviewScore` and `ReviewSummary`, plus the ten dimensions and eight failure
  conditions. The package and the key are separate exported schemas because they
  have separate audiences.
- `compare-models` now carries `result_id`, `run_id`, processor name, version and
  weight digest per outcome. POC-007 recorded none of these, so a review built on
  it could not have been traceable; that was a gap in POC-007's own acceptance
  criterion ("results remain traceable") which only surfaced when something
  downstream needed to consume it.
- Two commands: `bench review-build` and `bench review-aggregate`, the latter
  opening the sealed key only when explicitly asked.
- **The licence standing travels with the attribution.** A research-only model
  cannot be laundered into a recommendation by scoring well — the attribution
  carries `eligible_for_commercial_recommendation` alongside every verdict.

## What POC-008 does not do

**It does not conduct the review.** There are no reviewers yet and no corpus of
real images — the demonstration above uses two synthetic reviewers over synthetic
fixtures. The workflow is built and exercised end to end; the actual quality
judgement on Real-ESRGAN and SwinIR still requires people and real material.

**It does not resolve ties automatically.** A third review is *flagged*, not
simulated. Deciding what happens when three reviewers still disagree is a product
question, not an engineering one.
