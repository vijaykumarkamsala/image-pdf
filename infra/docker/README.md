# Container definitions

**Implemented by POC-006 — General AI adapter foundation. Written, not yet built.**

| File | Purpose |
| --- | --- |
| [`inference.Dockerfile`](inference.Dockerfile) | Pinned CPU inference runtime for the AI adapter |
| [`requirements-runtime.txt`](requirements-runtime.txt) | Exact runtime versions installed inside it |

## Status: unexercised

Docker is not installed on the development machine, so this definition has never
been built or run. It is written now because POC-006 requires a containerised
pinned runtime and because deferring it to a CI host would mean writing it blind.

**No figure produced inside this container is authoritative until it has been
built and its output compared against a host run of the same asset.** Saying that
here rather than discovering it later is the point.

Three things must be settled before that first authoritative build. They are
absent rather than guessed, because a wrong value that looks precise is worse
than an honest gap:

- [ ] `BASE_IMAGE` pinned to a registry digest, not a tag
- [ ] `--require-hashes` on the requirements install, hashes resolved at pin time
- [ ] libvips package name and version confirmed on the chosen base

## Why the container exists

Two reasons, and only the first is the obvious one.

**A pinned runtime.** Comparability across the benchmark depends on every result
being produced by the same build. fp32 CPU convolution is deterministic for a
fixed torch version and thread count, and not across different ones — so the
container pins `OMP_NUM_THREADS` explicitly rather than inheriting the host's
core count.

**An honest memory figure.** `peak_rss_bytes` is a process-lifetime high-water
mark. When the AI adapter and the deterministic control run in one process, the
control reports the model's peak as though it were its own — which is exactly
what the first POC-006 comparison showed: 410 MB against a Lanczos resize. That
is true of the process and false of the operation. A container running one
operation is the only place a per-call total is trustworthy.

## Two things it deliberately does not do

**It does not bake in the weights.** No weight licence is stated anywhere in the
Real-ESRGAN repository. Putting the files in an image layer would redistribute
them, which is a decision nobody has taken. They are mounted at run time and
verified by SHA-256 at load:

```
docker run --rm --network none \
  -v "$PWD/.tools/models:/weights:ro" \
  ipw-inference-runtime version
```

**It does not install torch from PyPI.** On Linux the default wheel bundles
NVIDIA CUDA runtime libraries under the NVIDIA Software Licence Agreement — not
permissive, and not reviewed. The Dockerfile installs from the CPU index
explicitly. That line is a licence control, not a size optimisation, and removing
it would quietly acquire unreviewed components.

## Network

`--network none` at run time, and the adapter's own `no_network()` guard
independently refuses socket creation during inference. Two mechanisms rather
than one, because Gate B is a claim that has to be testable: the guard is what a
test can assert, the flag is what holds when the code is wrong.

## Licence standing of anything this container produces

Real-ESRGAN is permitted for `local_research` and `internal_benchmark` only. Its
weights have no stated licence and derive from DIV2K, which is published for
academic research only. Every artifact carries that marking, and the image
carries it as an OCI label so it survives being pulled somewhere else.

See [`data/licences/register.json`](../../data/licences/register.json) and
[`docs/adr/ADR-0005-ai-adapter-foundation.md`](../../docs/adr/ADR-0005-ai-adapter-foundation.md).
