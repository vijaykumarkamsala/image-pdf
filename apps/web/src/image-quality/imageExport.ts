import type { ImageFileInspection, InspectedMediaType } from "./imageFileInspection.ts";

export const IMAGE_EXPORT_FORMATS = ["png", "jpeg", "webp"] as const;

export type ImageExportFormat = typeof IMAGE_EXPORT_FORMATS[number];
export type ImageExportJpegMatte = "reject" | "white" | "black";

export interface ImageExportSettings {
  format: ImageExportFormat;
  quality: number;
  jpegMatte: ImageExportJpegMatte;
}

export interface ImageExportEvidence {
  width: number;
  height: number;
  mediaType: InspectedMediaType;
  byteSize: number;
  outputSha256: string;
  transparentPixels: boolean;
  transparencyFlattened: boolean;
}

export const IMAGE_EXPORT_MEDIA_TYPES: Record<ImageExportFormat, InspectedMediaType> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const IMAGE_EXPORT_EXTENSIONS: Record<ImageExportFormat, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

export function sanitizeImageExportSettings(settings: ImageExportSettings): ImageExportSettings {
  if (!IMAGE_EXPORT_FORMATS.includes(settings.format)) throw new Error("Choose a supported export format.");
  if (!["reject", "white", "black"].includes(settings.jpegMatte)) {
    throw new Error("Choose a valid JPEG transparency policy.");
  }
  return {
    format: settings.format,
    quality: Math.round(Math.max(40, Math.min(100, Number.isFinite(settings.quality) ? settings.quality : 92))),
    jpegMatte: settings.jpegMatte,
  };
}

export function assertImageExportInspection(
  inspection: ImageFileInspection,
  format: ImageExportFormat,
  expectedWidth: number,
  expectedHeight: number,
) {
  const expectedMediaType = IMAGE_EXPORT_MEDIA_TYPES[format];
  if (inspection.mediaType !== expectedMediaType) {
    throw new Error(
      `The browser encoded ${inspection.mediaType} instead of the requested ${expectedMediaType}. No mismatched export was created.`,
    );
  }
  if (inspection.width !== expectedWidth || inspection.height !== expectedHeight) {
    throw new Error(
      `The encoded ${format.toUpperCase()} is ${inspection.width} × ${inspection.height} px instead of the required `
      + `${expectedWidth} × ${expectedHeight} px. No mismatched export was created.`,
    );
  }
  if (inspection.animated || inspection.frameCount !== 1) {
    throw new Error("The export encoder unexpectedly produced an animated image. No export was created.");
  }
}

export function imageExportFilename(
  sourceName: string,
  width: number,
  height: number,
  settings: ImageExportSettings,
) {
  const safe = sanitizeImageExportSettings(settings);
  const stem = sourceName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "image";
  const quality = safe.format === "png" ? "" : `-q${safe.quality}`;
  return `${stem}-export-${width}x${height}${quality}.${IMAGE_EXPORT_EXTENSIONS[safe.format]}`;
}
