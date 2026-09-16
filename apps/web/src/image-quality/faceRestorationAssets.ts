import { faceModelBlockers, type FaceModelRelease } from "./faceDetailRestoration.ts";
import { sha256Bytes } from "./sha256.ts";

/** Only an explicit, reviewed bundle can construct the unregistered adapter. */
export interface FaceInferenceManifest {
  runtime: "onnxruntime-web@1.29.0/wasm-single-thread";
  detector: { sha256: string; bytes: number };
  restorer: {
    sha256: string; bytes: number; imageInput: string; imageOutput: string;
    fidelityInput: { name: string; type: "float32" | "float64"; dims: number[] };
  };
}
export interface FaceInferenceAssets { manifest: FaceInferenceManifest; detector: Blob; restorer: Blob }
export const YUNET_ARTIFACT = Object.freeze({
  sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  bytes: 232589,
});

export function faceInferenceManifestBytes(manifest: FaceInferenceManifest) {
  const { detector, restorer } = manifest;
  return new TextEncoder().encode(JSON.stringify([
    "ipw-face-inference-bundle-v1", manifest.runtime, detector.sha256, detector.bytes,
    restorer.sha256, restorer.bytes, restorer.imageInput, restorer.imageOutput,
    restorer.fidelityInput.name, restorer.fidelityInput.type, restorer.fidelityInput.dims,
    "yunet640-overview-native-tiles32-score085-nms03", "five-point-similarity512-rmse24",
    "source-coordinate-ellipse148x168-feather008-v1",
    "fidelity-offset015020-distinct-endpoints-v1",
  ]));
}

export async function validateFaceInferenceAssets(assets: FaceInferenceAssets, release: Readonly<FaceModelRelease>) {
  const blockers = faceModelBlockers(release);
  if (blockers.length) throw new Error(`Face detail is unavailable. ${blockers.join(" ")}`);
  const { manifest, detector, restorer } = assets;
  if (manifest.runtime !== "onnxruntime-web@1.29.0/wasm-single-thread"
    || manifest.detector.sha256 !== YUNET_ARTIFACT.sha256 || manifest.detector.bytes !== YUNET_ARTIFACT.bytes
    || manifest.restorer.sha256 !== release.weightsSha256
    || !Number.isSafeInteger(manifest.restorer.bytes) || manifest.restorer.bytes <= 0 || manifest.restorer.bytes > 500_000_000
    || ![manifest.restorer.imageInput, manifest.restorer.imageOutput, manifest.restorer.fidelityInput.name].every((name) => typeof name === "string" && name.trim())
    || manifest.restorer.imageInput === manifest.restorer.fidelityInput.name
    || !["float32", "float64"].includes(manifest.restorer.fidelityInput.type)
    || manifest.restorer.fidelityInput.dims.length > 2 || manifest.restorer.fidelityInput.dims.some((dim) => dim !== 1)
    || detector.size !== manifest.detector.bytes || restorer.size !== manifest.restorer.bytes) {
    throw new Error("The face inference bundle does not match its pinned runtime, detector or restoration contract.");
  }
  if (await sha256Bytes(faceInferenceManifestBytes(manifest)) !== release.dependencyLockSha256) throw new Error("The face model/dependency/processing bundle changed after approval.");
  const [detectorBytes, restorerBytes] = await Promise.all([detector.arrayBuffer(), restorer.arrayBuffer()]);
  const [detectorHash, restorerHash] = await Promise.all([
    sha256Bytes(new Uint8Array(detectorBytes)), sha256Bytes(new Uint8Array(restorerBytes)),
  ]);
  if (detectorHash !== manifest.detector.sha256 || restorerHash !== manifest.restorer.sha256) throw new Error("Face inference model bytes failed their SHA-256 checks.");
  return { detectorBytes, restorerBytes };
}
