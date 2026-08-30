# Quality and Release Plan

## 1. Release gate

External tester release is blocked by:

- Any known Critical or High defect.
- Any blocker in an approved customer journey.
- Any Medium defect without accepted workaround, named owner and target resolution.
- Failed security, licence, deletion, backup-restore or data-isolation gate.
- Failed golden/quality threshold for an advertised processing operation.
- Unverified migration/rollback for a changed persistent schema.

## 2. Required verification layers

| Layer | Minimum evidence |
|---|---|
| Unit/property | Domain rules, parsers, transforms, invariants and failure normalisation |
| Contract | TypeScript/Python/API schemas, compatibility and code generation |
| Integration | Database, object store, queue, worker, OAuth/cloud provider and e-sign provider fakes/sandboxes |
| End-to-end | Every approved guest, signed-in, editor, export, batch, PDF, share and signing journey |
| Visual regression | Home, editor states, panels, errors, mobile/tablet/desktop and export previews |
| Accessibility | Keyboard, focus, screen reader, contrast, reduced motion and PDF structure/preflight |
| Security | AuthZ/tenant isolation, uploads, active PDF content, malware, secrets, SSRF, signed URLs and API/webhooks |
| Performance | Preview latency, memory, upload/resume, job queues, 1/10/50 batches, large image/PDF and concurrency |
| Processing quality | Golden outputs, objective metrics, critical-region checks and blind human review |
| Compatibility | Rights-cleared real images/PDFs, fonts, profiles, forms, tags, signatures and malformed corpus |
| Operations | Retry/checkpoint, dead letter, rollback, alerts, backup restore and deletion proof |
| Licensing | Code, weights, fonts, providers and executed dependency path |

## 3. Image quality acceptance

- Important text/logo regions do not materially change in Preserve/normal modes.
- Face identity checks do not regress beyond approved thresholds.
- No visible tile seams, halos, ringing, banding or new compression damage.
- Recreate regions are recorded and customer-approved.
- Claimed physical size/profile passes its preflight.
- “No enhancement needed” is supported and tested.

## 4. PDF acceptance

- Original hash remains unchanged.
- Page operations preserve unrelated objects.
- Capability report agrees with actual supported operations.
- Signed/certified documents are protected and derivatives clearly labelled.
- Redaction verification proves target content/hidden data removal.
- Conversion/repair fidelity report identifies known differences.
- Accessibility and archival profiles pass selected conformance tools.
- Custom PDF implementation cannot ship solely because unit tests pass; real-world differential tests are required.

## 5. Tester rollout

1. Internal engineering and QA with synthetic/rights-cleared data.
2. Trusted friends and domain users, including print/textile users when available.
3. Closed beta with monitored cohorts.
4. Wider release only after cohort metrics and defect gate pass.

Use feature flags, reversible migrations, canary workers and documented rollback at every stage.

## 6. Bug reports and diagnostics

- Automatically attach trace ID and safe environment/job facts.
- Screenshots/files require explicit review and consent.
- Never attach secrets, passwords, raw signing credentials or hidden customer files.
- Preserve reporter communication, severity, reproduction, affected versions, owner and resolution evidence.

## 7. Domain validation

The neighbour/factory interview is not a blocker for building generic profile architecture. Before declaring a specific textile profile production-approved, validate its physical tolerances, accepted formats, RIP, fabric, ink, repeat, colour and proof workflow with real domain users and sample output.
