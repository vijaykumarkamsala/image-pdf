import {
  applyReviewedFaceCandidate, faceCandidateSha256, faceModelBlockers, validateFaceDetailContext, validateFaceCandidateForContext,
  type FaceDetailCandidate, type FaceModelRelease,
} from "./faceDetailRestoration.ts";
import { inspectImageFile } from "./imageFileInspection.ts";
import { processingBudget } from "./imageQualityPolicy.ts";
import { tagSrgbPng } from "./pngMetadata.ts";
import { sha256Bytes } from "./sha256.ts";
import type { FaceReviewCommand, FaceReviewInput, FaceReviewReply } from "./WorkerFaceReviewRenderer.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FaceReviewCommand & { id: number }>) => void) | null;
  postMessage(value: unknown, transfer?: Transferable[]): void;
};
let input: FaceReviewInput | null = null;
let release: FaceModelRelease | null = null;
let sourceBitmap: ImageBitmap | null = null;
let basePixels: Uint8ClampedArray | null = null;
let sourcePixels: Uint8ClampedArray | null = null;

function canvas(width: number, height: number) {
  const surface = new OffscreenCanvas(width, height);
  const context = surface.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot render face comparisons. Your original is unchanged.");
  context.imageSmoothingEnabled = false;
  return { surface, context };
}

async function encode(pixels: Uint8ClampedArray, width: number, height: number) {
  const { surface, context } = canvas(width, height);
  context.putImageData(new ImageData(pixels.slice(), width, height), 0, 0);
  return surface.convertToBlob({ type: "image/png" });
}

function ready() {
  if (!input || !release || !sourceBitmap || !basePixels || !sourcePixels) throw new Error("Prepare the original and base result before face review.");
  return { input, release, sourceBitmap, basePixels, sourcePixels };
}

async function prepare(next: FaceReviewInput, nextRelease: FaceModelRelease): Promise<FaceReviewReply> {
  const blockers = faceModelBlockers(nextRelease);
  if (blockers.length) throw new Error(`Face detail is unavailable. ${blockers.join(" ")}`);
  validateFaceDetailContext(next.context);
  if (input) throw new Error("Create a fresh face renderer for each original/base result.");
  const budget = processingBudget((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  if (next.context.outputWidth * next.context.outputHeight > budget.outputPixels
    || next.context.sourceWidth * next.context.sourceHeight > budget.sourcePixels
    || Math.max(next.context.outputWidth, next.context.outputHeight) > budget.maxCanvasEdge) {
    throw new Error("This result needs a server-side face renderer, which is not available yet. No image was resized or changed.");
  }
  const [sourceHeader, baseHeader] = await Promise.all([inspectImageFile(next.original), inspectImageFile(next.base)]);
  if (sourceHeader.animated || baseHeader.animated || baseHeader.bitDepth > 8 || baseHeader.mediaType !== "image/png") {
    throw new Error("Animated and high-bit-depth face results need the future native face renderer; they will not be flattened or reduced silently.");
  }
  const [sourceHash, baseHash] = await Promise.all([
    next.original.arrayBuffer().then((bytes) => sha256Bytes(new Uint8Array(bytes))),
    next.base.arrayBuffer().then((bytes) => sha256Bytes(new Uint8Array(bytes))),
  ]);
  if (sourceHash !== next.context.sourceSha256 || baseHash !== next.context.baseOutputSha256) {
    throw new Error("The original or base result changed before face review.");
  }
  const original = await createImageBitmap(next.original);
  let base: ImageBitmap | null = null;
  try {
    base = await createImageBitmap(next.base);
    if (original.width !== next.context.sourceWidth || original.height !== next.context.sourceHeight
      || base.width !== next.context.outputWidth || base.height !== next.context.outputHeight) {
      throw new Error("Decoded face-review dimensions do not match the verified image.");
    }
    const source = canvas(original.width, original.height);
    source.context.drawImage(original, 0, 0);
    sourcePixels = source.context.getImageData(0, 0, original.width, original.height).data;
    const target = canvas(base.width, base.height);
    target.context.drawImage(base, 0, 0);
    basePixels = target.context.getImageData(0, 0, base.width, base.height).data;
    if (basePixels.some((value, offset) => offset % 4 === 3 && value !== 255)) {
      basePixels = null;
      sourcePixels = null;
      throw new Error("Transparent face results need the native face renderer; browser canvas rounding cannot guarantee untouched outside pixels.");
    }
    input = next;
    release = nextRelease;
    sourceBitmap = original;
    return { type: "prepared", sourcePixels: sourcePixels.slice() };
  } catch (error) {
    sourcePixels = null;
    basePixels = null;
    original.close();
    throw error;
  } finally {
    base?.close();
  }
}

async function preview(candidates: Array<FaceDetailCandidate & { candidateSha256: string }>): Promise<FaceReviewReply> {
  const current = ready();
  if (candidates.length !== 2 && candidates.length !== 3) throw new Error("Review two or three candidates.");
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new Error("Distinct face candidates are required.");
  for (const candidate of candidates) validateFaceCandidateForContext(candidate, current.input.context, current.release);
  const region = candidates[0].region;
  const original = canvas(region.width, region.height);
  const sourceRegion = {
    x: region.x * current.input.context.sourceWidth / current.input.context.outputWidth,
    y: region.y * current.input.context.sourceHeight / current.input.context.outputHeight,
    width: region.width * current.input.context.sourceWidth / current.input.context.outputWidth,
    height: region.height * current.input.context.sourceHeight / current.input.context.outputHeight,
  };
  original.context.drawImage(current.sourceBitmap, sourceRegion.x, sourceRegion.y, sourceRegion.width,
    sourceRegion.height, 0, 0, region.width, region.height);
  const croppedBase = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row += 1) {
    const start = ((region.y + row) * current.input.context.outputWidth + region.x) * 4;
    croppedBase.set(current.basePixels.subarray(start, start + region.width * 4), row * region.width * 4);
  }
  const proposals = [];
  for (const candidate of candidates) {
    if (candidate.candidateSha256 !== await faceCandidateSha256(candidate)
      || JSON.stringify(candidate.region) !== JSON.stringify(region)) throw new Error("Face comparison pixels or framing changed.");
    // Preview composition is not export approval. A temporary crop context avoids full renders.
    const patch = croppedBase.slice();
    for (let index = 0; index < candidate.mask.length; index += 1) {
      if (patch[index * 4 + 3] === 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const offset = index * 4 + channel;
        patch[offset] += (candidate.pixels[offset] - patch[offset]) * candidate.mask[index] / 255;
      }
    }
    const map = new Uint8ClampedArray(region.width * region.height * 4);
    for (let index = 0; index < candidate.mask.length; index += 1) map.set([255, 80, 160, candidate.mask[index]], index * 4);
    proposals.push({ candidateSha256: candidate.candidateSha256, bytes: await encode(patch, region.width, region.height),
      regionMap: await encode(map, region.width, region.height) });
  }
  return { type: "previews", previews: {
    original: await original.surface.convertToBlob({ type: "image/png" }),
    base: await encode(croppedBase, region.width, region.height),
    candidates: proposals, region, sourceRegion,
  } };
}

async function execute(command: FaceReviewCommand): Promise<FaceReviewReply> {
  if (command.type === "prepare") return prepare(command.input, command.release);
  if (command.type === "preview") return preview(command.candidates);
  const current = ready();
  const composed = await applyReviewedFaceCandidate(current.basePixels, current.input.context,
    command.candidate, command.review, current.release);
  const png = await encode(composed.pixels, current.input.context.outputWidth, current.input.context.outputHeight);
  const tagged = tagSrgbPng(new Uint8Array(await png.arrayBuffer()), {
    ...current.input.metadata, sourceSha256: current.input.context.sourceSha256,
    engineId: current.release.id, engineVersion: current.release.version,
    modelSha256: current.release.weightsSha256, usage: "explicit-face-recreate",
    route: "explicit-reviewed-face-recreate", faceRecreateEvidence: composed.evidence,
    outputWidth: current.input.context.outputWidth, outputHeight: current.input.context.outputHeight,
  });
  return { type: "applied", output: {
    bytes: tagged.buffer as ArrayBuffer, outputSha256: await sha256Bytes(tagged), evidence: composed.evidence,
  } };
}

// Serialize requests so no preparation or candidate state can interleave across awaits.
let queue = Promise.resolve();
scope.onmessage = (event) => {
  const command = event.data;
  queue = queue.then(async () => {
    try {
      const reply = await execute(command);
      const transfer = reply.type === "prepared" ? [reply.sourcePixels.buffer]
        : reply.type === "applied" ? [reply.output.bytes] : [];
      scope.postMessage({ id: command.id, ok: true, reply }, transfer);
    } catch (error) {
      scope.postMessage({ id: command.id, ok: false, message: error instanceof Error ? error.message : "Face rendering failed; previous images remain unchanged." });
    }
  });
};
