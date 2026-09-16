/** TEST ONLY: real YuNet + an owned synthetic ONNX restorer. Not a model licence or quality approval. */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { FaceDetailPanel } from "../../src/image-quality/FaceDetailPanel";
import { WorkerFaceRestorationEngine } from "../../src/image-quality/WorkerFaceRestorationEngine";
import { faceInferenceManifestBytes, YUNET_ARTIFACT, type FaceInferenceAssets } from "../../src/image-quality/faceRestorationAssets";
import { WorkerFaceReviewRenderer, type FaceReviewInput, type FaceReviewRenderer } from "../../src/image-quality/WorkerFaceReviewRenderer";
import { sha256Bytes } from "../../src/image-quality/sha256";
import type { FaceDetailCandidate, FaceModelRelease } from "../../src/image-quality/faceDetailRestoration";

// Generated via onnx.helper/checker: FLOAT input[1,3,512,512], scalar weight;
// output = Clip(input + weight * 0.08, -1, 1). It cannot reconstruct missing detail.
const ownedRestorer = "CAkSG2ltYWdlLXF1YWxpdHktZm9jdXNlZC10ZXN0czr6AgosEgRiaWFzIghDb25zdGFudCoaCgV2YWx1ZSoOEAEiBArXoz1CBGJpYXOgAQQKGgoGd2VpZ2h0CgRiaWFzEgVzaGlmdCIDTXVsChwKBWlucHV0CgVzaGlmdBIHY2hhbmdlZCIDQWRkCjISB21pbmltdW0iCENvbnN0YW50Kh0KBXZhbHVlKhEQASIEAACAv0IHbWluaW11baABBAoyEgdtYXhpbXVtIghDb25zdGFudCodCgV2YWx1ZSoREAEiBAAAgD9CB21heGltdW2gAQQKKQoHY2hhbmdlZAoHbWluaW11bQoHbWF4aW11bRIGb3V0cHV0IgRDbGlwEiRzeW50aGV0aWMtZmFjZS1tZWNoYW5pY3Mtbm90LXF1YWxpdHlaIQoFaW5wdXQSGAoWCAESEgoCCAEKAggDCgMIgAQKAwiABFoQCgZ3ZWlnaHQSBgoECAESAGIiCgZvdXRwdXQSGAoWCAESEgoCCAEKAggDCgMIgAQKAwiABEIECgAQEQ==";
const decode = (encoded: string) => Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
let proposals: FaceDetailCandidate[] = [];
let composed: Awaited<ReturnType<FaceReviewRenderer["apply"]>> | null = null;
let preparedPixels: Uint8ClampedArray | null = null;
let modelAssets: FaceInferenceAssets | null = null;
let modelRelease: FaceModelRelease | null = null;
const metrics = { generations: 0, preparations: 0, previews: 0, applications: 0 };

export async function mountAutomaticFaceHarness(sourceEncoded: string, detectorEncoded: string) {
  const original = new Blob([decode(sourceEncoded)], { type: "image/png" });
  const detector = new Blob([decode(detectorEncoded)]), restorer = new Blob([decode(ownedRestorer)]);
  const modelHash = await sha256Bytes(new Uint8Array(await restorer.arrayBuffer()));
  const assets: FaceInferenceAssets = { detector, restorer, manifest: {
    runtime: "onnxruntime-web@1.29.0/wasm-single-thread", detector: { ...YUNET_ARTIFACT },
    restorer: { sha256: modelHash, bytes: restorer.size, imageInput: "input", imageOutput: "output", fidelityInput: { name: "weight", type: "float32", dims: [] } },
  } };
  const release: FaceModelRelease = { id: "owned-test-only-no-restoration-quality", version: "1", weightsSha256: modelHash,
    dependencyLockSha256: await sha256Bytes(faceInferenceManifestBytes(assets.manifest)),
    commercialRights: "approved", rightsEvidenceId: "test-only-no-production-clearance",
    qualityReview: "approved", qualityEvidenceId: "test-only-no-face-quality-acceptance" };
  modelAssets = assets; modelRelease = release;
  const surface = new OffscreenCanvas(1290, 2796), context = surface.getContext("2d")!;
  context.fillStyle = "rgb(80,60,45)"; context.fillRect(0, 0, 1290, 2796);
  const base = await surface.convertToBlob({ type: "image/png" });
  const input: FaceReviewInput = { original, base, context: {
    sourceSha256: await sha256Bytes(new Uint8Array(await original.arrayBuffer())),
    baseOutputSha256: await sha256Bytes(new Uint8Array(await base.arrayBuffer())),
    sourceWidth: 1290, sourceHeight: 2796, outputWidth: 1290, outputHeight: 2796 },
    metadata: { sourceSha256: "", engineId: "test-only-base", engineVersion: "1", route: "test-only",
      strength: 100, scale: 1, modelSha256: null, usage: "deterministic", contentClass: "photograph",
      classificationConfidence: 1, outputWidth: 1290, outputHeight: 2796 } };
  input.metadata.sourceSha256 = input.context.sourceSha256;
  const host = document.createElement("section"); host.id = "automatic-face-review-harness";
  host.setAttribute("aria-label", "Actual detector with synthetic restoration test"); document.body.append(host);
  createRoot(host).render(createElement(FaceDetailPanel, { disabled: false, filename: "private-test.png", input,
    adapter: { release, create() {
      const engine = new WorkerFaceRestorationEngine(release, assets);
      return { release, async generateCandidates(request, signal) {
        metrics.generations += 1; proposals = await engine.generateCandidates(request, signal); return proposals;
      }, dispose() { engine.dispose(); } };
    } }, createRenderer() {
      const renderer = new WorkerFaceReviewRenderer();
      return {
        async prepare(incoming, approved, signal) { metrics.preparations += 1; preparedPixels = await renderer.prepare(incoming, approved, signal); return preparedPixels; },
        preview(candidates, signal) { metrics.previews += 1; return renderer.preview(candidates, signal); },
        async apply(candidate, review, signal) { metrics.applications += 1; composed = await renderer.apply(candidate, review, signal); return composed; },
        dispose() { renderer.dispose(); },
      };
    },
  }));
}

export function automaticFaceEvidence() {
  return { metrics: { ...metrics }, proposals: proposals.map((candidate) => ({ id: candidate.id,
    fidelity: candidate.fidelity, region: candidate.region, alignment: candidate.alignment,
    nonzeroMaskPixels: candidate.mask.filter((weight) => weight !== 0).length })),
    outputEvidence: composed?.evidence, outputSha256: composed?.outputSha256 };
}

export async function probeAutomaticFailures() {
  if (!preparedPixels || !modelAssets || !modelRelease) throw new Error("Run the authorized portrait preparation first.");
  const empty = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 3; i < empty.length; i += 4) empty[i] = 255;
  const duplicated = new Uint8ClampedArray(800 * 400 * 4);
  // An explicitly local test crop duplicates the same authorized face; never saved/shared.
  for (let y = 0; y < 400; y += 1) {
    const offset = ((1000 + y) * 1290 + 500) * 4;
    const row = preparedPixels.subarray(offset, offset + 400 * 4);
    duplicated.set(row, y * 800 * 4); duplicated.set(row, (y * 800 + 400) * 4);
  }
  const messages: string[] = [];
  for (const [pixels, width, height, cancel] of [[empty, 256, 256, false], [duplicated, 800, 400, false], [empty, 256, 256, true]] as const) {
    const before = pixels.slice(), engine = new WorkerFaceRestorationEngine(modelRelease, modelAssets), controller = new AbortController();
    try {
      const pending = engine.generateCandidates({ context: { sourceSha256: "a".repeat(64), baseOutputSha256: "b".repeat(64),
        sourceWidth: width, sourceHeight: height, outputWidth: width, outputHeight: height }, sourcePixels: pixels,
        consent: { sourceSha256: "a".repeat(64), allowReconstructedFaceDetail: true }, fidelity: 0.8, candidateCount: 3 }, controller.signal);
      if (cancel) controller.abort();
      await pending; throw new Error("A failure probe unexpectedly produced candidates.");
    } catch (error) { messages.push(error instanceof Error ? error.message : String(error)); }
    finally { engine.dispose(); }
    if (!pixels.every((value, i) => value === before[i])) throw new Error("Failure probe mutated the immutable decoded input.");
  }
  return messages;
}
