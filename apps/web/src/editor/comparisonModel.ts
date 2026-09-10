import type { HistogramSummary } from "ipw-contracts-ts/product";

export function sampleCanvasHistogram(canvas: HTMLCanvasElement | null): HistogramSummary {
  const bins = 64;
  const red = Array.from({ length: bins }, () => 0);
  const green = Array.from({ length: bins }, () => 0);
  const blue = Array.from({ length: bins }, () => 0);
  if (!canvas || canvas.width < 1 || canvas.height < 1) return { red, green, blue, shadow_clipping: false, highlight_clipping: false };
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return { red, green, blue, shadow_clipping: false, highlight_clipping: false };
    const stride = Math.max(4, Math.floor(pixels.length / 120_000 / 4) * 4);
    let samples = 0;
    let shadows = 0;
    let highlights = 0;
    for (let index = 0; index < pixels.length; index += stride) {
      if (pixels[index + 3] < 8) continue;
      const r = pixels[index]!;
      const g = pixels[index + 1]!;
      const b = pixels[index + 2]!;
      red[Math.min(bins - 1, Math.floor(r / 4))]! += 1;
      green[Math.min(bins - 1, Math.floor(g / 4))]! += 1;
      blue[Math.min(bins - 1, Math.floor(b / 4))]! += 1;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luminance <= 2) shadows += 1;
      if (luminance >= 253) highlights += 1;
      samples += 1;
    }
    return { red, green, blue, shadow_clipping: samples > 0 && shadows / samples > 0.01, highlight_clipping: samples > 0 && highlights / samples > 0.01 };
  } catch {
    return { red, green, blue, shadow_clipping: false, highlight_clipping: false };
  }
}
