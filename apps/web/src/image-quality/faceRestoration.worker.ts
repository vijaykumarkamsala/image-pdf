import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import { validateFaceRestorationRequest, type FaceDetailCandidate, type FaceModelRelease } from "./faceDetailRestoration.ts";
import { validateFaceInferenceAssets, type FaceInferenceManifest } from "./faceRestorationAssets.ts";
import {
  alignedFacePixels, decodeYuNet, faceCandidateFidelities, faceDetectionWindows, faceDetectorTensor, inverseAlignedFacePatch,
  suppressDuplicateFaces, validatedFaceAlignment, type DetectedFace,
} from "./faceRestorationGeometry.ts";
import { processingBudget } from "./imageQualityPolicy.ts";
import type { FaceInferenceCommand } from "./WorkerFaceRestorationEngine.ts";

type Ort = typeof import("onnxruntime-web/wasm");
type Session = import("onnxruntime-web").InferenceSession;
const scope = self as unknown as { onmessage: ((event: MessageEvent<FaceInferenceCommand>) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
let ort: Ort | null = null, detector: Session | null = null, restorer: Session | null = null;
let manifest: FaceInferenceManifest | null = null, release: FaceModelRelease | null = null;

async function prepare(command: FaceInferenceCommand) {
  if (!command.assets) throw new Error("An explicitly reviewed face inference bundle is required.");
  const verified = await validateFaceInferenceAssets(command.assets, command.release);
  ort = await import("onnxruntime-web/wasm");
  if (ort.env.versions.web !== "1.29.0" || ort.env.versions.common !== "1.29.0") throw new Error("The installed face inference runtime does not match its reviewed pin.");
  ort.env.logLevel = "warning"; ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
  try {
    detector = await ort.InferenceSession.create(verified.detectorBytes, { executionProviders: ["wasm"] });
    restorer = await ort.InferenceSession.create(verified.restorerBytes, { executionProviders: ["wasm"] });
    manifest = structuredClone(command.assets.manifest);
    const names = Object.keys({ cls_8: 1, cls_16: 1, cls_32: 1, obj_8: 1, obj_16: 1, obj_32: 1,
      bbox_8: 1, bbox_16: 1, bbox_32: 1, kps_8: 1, kps_16: 1, kps_32: 1 });
    if (detector.inputNames.length !== 1 || detector.inputNames[0] !== "input"
      || detector.outputNames.length !== 12 || !names.every((name) => detector!.outputNames.includes(name))
      || restorer.inputNames.length !== 2 || ![manifest.restorer.imageInput, manifest.restorer.fidelityInput.name].every((name) => restorer!.inputNames.includes(name))
      || restorer.outputNames.length !== 1 || restorer.outputNames[0] !== manifest.restorer.imageOutput) throw new Error("Unexpected detector/restoration ONNX inputs or outputs.");
    release = { ...command.release };
  } catch (error) {
    await detector?.release(); await restorer?.release(); detector = null; restorer = null; manifest = null; release = null;
    throw error;
  }
}

async function infer(command: FaceInferenceCommand): Promise<FaceDetailCandidate[]> {
  validateFaceRestorationRequest(command.request, command.release);
  const { context, sourcePixels, candidateCount, fidelity } = command.request;
  const budget = processingBudget((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  if (context.sourceWidth * context.sourceHeight > budget.sourcePixels || context.outputWidth * context.outputHeight > budget.outputPixels) throw new Error("This face restoration needs the future native face worker; no smaller image was substituted.");
  if (sourcePixels.some((alpha, index) => index % 4 === 3 && alpha !== 255)) throw new Error("Transparent source pixels need the future native face pipeline.");
  // Compute the complete scan plan before any model runs, not an optimistic partial scan.
  const windows = faceDetectionWindows(context.sourceWidth, context.sourceHeight);
  if (!detector || !restorer || !ort || !manifest || !release) await prepare(command);
  if ((Object.keys(command.release) as Array<keyof FaceModelRelease>).some((key) => command.release[key] !== release![key])) throw new Error("The approved face release changed; create a fresh engine.");
  const found: DetectedFace[] = [];
  for (const window of windows) {
    const prepared = faceDetectorTensor(sourcePixels, context.sourceWidth, context.sourceHeight, window);
    const tensor = new ort!.Tensor("float32", prepared.data, [1, 3, 640, 640]);
    const outputs = await detector!.run({ input: tensor });
    try {
      const heads: Record<string, Float32Array> = {};
      for (const [name, value] of Object.entries(outputs)) {
        if (value.type !== "float32") throw new Error("Face detector returned a non-float prediction.");
        heads[name] = value.data as Float32Array;
      }
      found.push(...decodeYuNet(heads, window));
    } finally { tensor.dispose(); for (const value of Object.values(outputs)) value.dispose(); }
  }
  const faces = suppressDuplicateFaces(found);
  if (!faces.length) throw new Error("No sufficiently confident face was found. Your original and enhanced image are unchanged.");
  if (faces.length !== 1) throw new Error("More than one possible face was found. Face selection is not available yet, so no person was chosen automatically.");
  const transform = validatedFaceAlignment(faces[0]);
  const aligned = alignedFacePixels(sourcePixels, context.sourceWidth, context.sourceHeight, transform);
  const plane = 512 * 512, data = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i += 1) for (let channel = 0; channel < 3; channel += 1) data[channel * plane + i] = aligned[i * 4 + channel] / 127.5 - 1;
  // Two/three actual fidelity settings, not repeated inference of the same proposal.
  const settings = faceCandidateFidelities(fidelity, candidateCount);
  const candidates: FaceDetailCandidate[] = [];
  for (let index = 0; index < settings.length; index += 1) {
    const spec = manifest!.restorer, weight = spec.fidelityInput;
    const imageTensor = new ort!.Tensor("float32", data, [1, 3, 512, 512]);
    const fidelityTensor = new ort!.Tensor(weight.type, weight.type === "float64" ? new Float64Array([settings[index]]) : new Float32Array([settings[index]]), weight.dims);
    const outputs = await restorer!.run({ [spec.imageInput]: imageTensor, [weight.name]: fidelityTensor });
    try {
      const output = outputs[spec.imageOutput];
      if (!output || output.type !== "float32" || output.dims.join(",") !== "1,3,512,512"
        || !(output.data instanceof Float32Array) || !output.data.every(Number.isFinite)) throw new Error("Face restoration returned invalid aligned pixels.");
      const pixels = new Uint8ClampedArray(plane * 4);
      for (let i = 0; i < plane; i += 1) {
        for (let channel = 0; channel < 3; channel += 1) pixels[i * 4 + channel] = Math.round((output.data[channel * plane + i] + 1) * 127.5);
        pixels[i * 4 + 3] = 255;
      }
      const patch = inverseAlignedFacePatch(pixels, transform, context.outputWidth, context.outputHeight, context.outputWidth / context.sourceWidth);
      candidates.push({ ...patch, id: `automatic-face-${index + 1}`, context: { ...context }, fidelity: settings[index], modelSha256: command.release.weightsSha256!,
        alignment: { detectorSha256: manifest!.detector.sha256, confidence: faces[0].confidence,
          sourceLandmarks: structuredClone(faces[0].landmarks), sourceToAlignedTransform: [...transform] } });
    } finally { imageTensor.dispose(); fidelityTensor.dispose(); for (const value of Object.values(outputs)) value.dispose(); }
  }
  return candidates;
}

let queue = Promise.resolve();
scope.onmessage = (event) => {
  const command = event.data;
  queue = queue.then(async () => {
    try {
      const candidates = await infer(command);
      scope.postMessage({ id: command.id, candidates }, candidates.flatMap((candidate) => [candidate.pixels.buffer, candidate.mask.buffer]));
    } catch (error) { scope.postMessage({ id: command.id, message: error instanceof Error ? error.message : "Face restoration failed; your original is unchanged." }); }
  });
};
