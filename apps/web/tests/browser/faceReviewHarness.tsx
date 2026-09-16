/** TEST ONLY. Not imported by src, registered as a route, or included in production assets.
 * Synthetic approval/model proves workflow mechanics, never face quality or real model rights.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { FaceDetailPanel } from "../../src/image-quality/FaceDetailPanel";
import { WorkerFaceReviewRenderer, type FaceReviewInput, type FaceReviewRenderer } from "../../src/image-quality/WorkerFaceReviewRenderer";
import { sha256Bytes } from "../../src/image-quality/sha256";
import type { FaceModelRelease, FaceRestorationEngine } from "../../src/image-quality/faceDetailRestoration";

const initialRelease: FaceModelRelease = {
  id: "synthetic-test-only", version: "1.0.0",
  weightsSha256: "c".repeat(64), dependencyLockSha256: "d".repeat(64),
  commercialRights: "approved", rightsEvidenceId: "synthetic-test-only-rights",
  qualityReview: "approved", qualityEvidenceId: "synthetic-test-only-quality",
};
const metrics = { preparations: 0, generations: 0, previews: 0, applications: 0, disposed: 0 };
let root: ReturnType<typeof createRoot> | null = null;
let input: FaceReviewInput;
let release = { ...initialRelease };
let failPreparation = false;
let slowGeneration = false;

async function png(size: number, colour: [number, number, number, number]) {
  const surface = new OffscreenCanvas(size, size);
  const context = surface.getContext("2d")!;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(colour, offset);
  context.putImageData(new ImageData(pixels, size, size), 0, 0);
  return surface.convertToBlob({ type: "image/png" });
}

function createEngine(): FaceRestorationEngine {
  return {
    release: { ...release },
    async generateCandidates(request, signal) {
      metrics.generations += 1;
      if (request.sourcePixels.length !== 256 * 256 * 4) throw new Error("Expected complete decoded source pixels.");
      if (slowGeneration) await new Promise((resolve) => setTimeout(resolve, 1500));
      signal.throwIfAborted();
      return Array.from({ length: 3 }, (_, index) => {
        const pixels = new Uint8ClampedArray(256 * 256 * 4);
        for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([110 + index * 15, 100 + index * 5, 125 - index * 10, 255], offset);
        const mask = new Uint8Array(256 * 256).fill(255); mask[0] = 0; mask[1] = 128;
        return { id: `synthetic-candidate-${index}`, context: { ...request.context }, pixels, mask,
          fidelity: 0.7 + index * 0.1, modelSha256: release.weightsSha256!,
          region: { x: 128, y: 128, width: 256, height: 256 } };
      });
    },
    dispose() { metrics.disposed += 1; },
  };
}

function createRenderer(): FaceReviewRenderer {
  const worker = new WorkerFaceReviewRenderer();
  return {
    prepare(incoming, pinnedRelease, signal) {
      metrics.preparations += 1;
      if (failPreparation) { failPreparation = false; return Promise.reject(new Error("Synthetic preparation failure")); }
      return worker.prepare(incoming, pinnedRelease, signal);
    },
    preview(candidates, signal) { metrics.previews += 1; return worker.preview(candidates, signal); },
    apply(candidate, review, signal) { metrics.applications += 1; return worker.apply(candidate, review, signal); },
    dispose() { worker.dispose(); },
  };
}

function render() {
  root!.render(createElement(FaceDetailPanel, { disabled: false, input, filename: "rights-free-test.png",
    adapter: { release: { ...release }, create: createEngine }, createRenderer }));
}

export async function mountFaceReviewHarness() {
  const original = await png(256, [20, 50, 100, 255]);
  const base = await png(512, [80, 60, 45, 255]);
  const sourceSha256 = await sha256Bytes(new Uint8Array(await original.arrayBuffer()));
  const baseOutputSha256 = await sha256Bytes(new Uint8Array(await base.arrayBuffer()));
  input = { original, base, context: { sourceSha256, baseOutputSha256,
    sourceWidth: 256, sourceHeight: 256, outputWidth: 512, outputHeight: 512 },
    metadata: { sourceSha256, engineId: "synthetic-base", engineVersion: "1.0.0", route: "synthetic-test-only",
      strength: 80, scale: 2, modelSha256: null, usage: "deterministic", contentClass: "photograph",
      classificationConfidence: 1, outputWidth: 512, outputHeight: 512 } };
  const host = document.createElement("section"); host.id = "face-review-harness";
  host.setAttribute("aria-label", "Synthetic face workflow test"); document.body.append(host);
  root = createRoot(host); render();
}

export function getMetrics() { return { ...metrics }; }
export function setSlowGeneration() { slowGeneration = true; }
export function failNextPreparation() { failPreparation = true; }
export function revokeRelease() { release = { ...release, commercialRights: "pending" }; render(); }
export async function replaceBase() {
  const base = await png(512, [85, 60, 45, 255]);
  input = { ...input, base, context: { ...input.context, baseOutputSha256: await sha256Bytes(new Uint8Array(await base.arrayBuffer())) } };
  render();
}
