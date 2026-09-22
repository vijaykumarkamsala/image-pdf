import { nativeFaceMaskRgba, nativeFacePreviewRgba } from "./nativeFacePreviewPixels";

interface PreviewRequest {
  id: number;
  width: number;
  height: number;
  bitDepth: 8 | 16;
  pixels: ArrayBuffer;
  mask: ArrayBuffer;
}

async function png(width: number, height: number, pixels: Uint8ClampedArray<ArrayBuffer>): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("The browser cannot prepare a face comparison canvas.");
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

globalThis.onmessage = (event: MessageEvent<PreviewRequest>) => {
  const request = event.data;
  void (async () => {
    if (!Number.isSafeInteger(request.width) || request.width < 1
      || !Number.isSafeInteger(request.height) || request.height < 1
      || (request.bitDepth !== 8 && request.bitDepth !== 16)
      || request.mask.byteLength !== request.width * request.height) {
      throw new Error("The face comparison artifacts do not match their region.");
    }
    const pixels = nativeFacePreviewRgba(request.pixels, request.width, request.height, request.bitDepth);
    const map = nativeFaceMaskRgba(request.mask, request.width, request.height);
    const [patch, regionMap] = await Promise.all([
      png(request.width, request.height, pixels), png(request.width, request.height, map),
    ]);
    globalThis.postMessage({ id: request.id, ok: true, patch, regionMap });
  })().catch((error) => globalThis.postMessage({ id: request.id, ok: false,
    message: error instanceof Error ? error.message : "Face comparison preparation failed." }));
};

export {};
