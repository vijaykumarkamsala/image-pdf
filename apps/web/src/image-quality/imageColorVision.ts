export const IMAGE_COLOR_VISION_MODES = ["protanopia", "deuteranopia", "tritanopia"] as const;

export type ImageColorVisionMode = typeof IMAGE_COLOR_VISION_MODES[number];
export type ImageColorVisionSelection = "standard" | ImageColorVisionMode;

export interface ImageColorVisionStatistics {
  processedPixels: number;
  changedPixels: number;
  clippedChannels: number;
}

export const IMAGE_COLOR_VISION_LABELS: Record<ImageColorVisionSelection, string> = {
  standard: "Standard colour",
  protanopia: "Protanopia",
  deuteranopia: "Deuteranopia",
  tritanopia: "Tritanopia",
};

// Full-severity (1.0) RGB simulation matrices published by Machado, Oliveira
// and Fernandes. The authors define the simulation as a matrix multiplication
// of the reference RGB vector. Source and coefficients:
// https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
const MATRICES: Record<ImageColorVisionMode, readonly [
  number, number, number,
  number, number, number,
  number, number, number,
]> = {
  protanopia: [
    0.152286, 1.052583, -0.204868,
    0.114503, 0.786281, 0.099216,
    -0.003882, -0.048116, 1.051998,
  ],
  deuteranopia: [
    0.367322, 0.860646, -0.227968,
    0.280085, 0.672501, 0.047413,
    -0.011820, 0.042940, 0.968881,
  ],
  tritanopia: [
    1.255528, -0.076749, -0.178779,
    -0.078411, 0.930809, 0.147602,
    0.004733, 0.691367, 0.303900,
  ],
};

const byte = (value: number) => Math.round(Math.max(0, Math.min(255, value)));

export function applyColorVisionToRgba(
  pixels: Uint8ClampedArray,
  mode: ImageColorVisionMode,
): ImageColorVisionStatistics {
  if (pixels.length % 4 !== 0) throw new Error("Colour-vision input must contain complete RGBA pixels.");
  const matrix = MATRICES[mode];
  const statistics: ImageColorVisionStatistics = {
    processedPixels: 0,
    changedPixels: 0,
    clippedChannels: 0,
  };

  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue;
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const rawRed = matrix[0] * red + matrix[1] * green + matrix[2] * blue;
    const rawGreen = matrix[3] * red + matrix[4] * green + matrix[5] * blue;
    const rawBlue = matrix[6] * red + matrix[7] * green + matrix[8] * blue;
    const nextRed = byte(rawRed);
    const nextGreen = byte(rawGreen);
    const nextBlue = byte(rawBlue);
    statistics.processedPixels += 1;
    if (rawRed < 0 || rawRed > 255) statistics.clippedChannels += 1;
    if (rawGreen < 0 || rawGreen > 255) statistics.clippedChannels += 1;
    if (rawBlue < 0 || rawBlue > 255) statistics.clippedChannels += 1;
    if (nextRed !== red || nextGreen !== green || nextBlue !== blue) statistics.changedPixels += 1;
    pixels[index] = nextRed;
    pixels[index + 1] = nextGreen;
    pixels[index + 2] = nextBlue;
  }

  return statistics;
}
