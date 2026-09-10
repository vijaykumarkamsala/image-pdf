import { createHash } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { IntakeFailure, SourceFacts, UploadConstraints } from "ipw-contracts-ts/product";

export interface InspectionOutcome {
  accepted: boolean;
  facts?: SourceFacts;
  failure?: IntakeFailure;
}

type SourceColourModel = "grayscale" | "rgb" | "cmyk" | "indexed";

interface RasterHeaderFacts {
  width: number;
  height: number;
  bitDepth: number;
  hasAlpha: boolean;
  hasIcc: boolean;
  orientation: number | null;
  frames: number;
  sensitive: string[];
  colourModel: SourceColourModel;
}

export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<"clean" | "malicious" | "unavailable">;
}

export class DeterministicMalwareScanner implements MalwareScanner {
  async scan(bytes: Uint8Array): Promise<"clean" | "malicious"> {
    const marker = Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "ascii");
    return Buffer.from(bytes).includes(marker) ? "malicious" : "clean";
  }
}

export class RequiredScannerUnavailable implements MalwareScanner {
  async scan(): Promise<"unavailable"> {
    return "unavailable";
  }
}

export class HeaderFirstInspectionAdapter {
  async inspect(input: {
    bytes: Uint8Array;
    displayName: string;
    expectedMediaType: string;
    constraints: UploadConstraints;
    malwareState: "clean" | "malicious" | "unavailable";
  }): Promise<InspectionOutcome> {
    const bytes = Buffer.from(input.bytes);
    if (input.malwareState === "malicious") return this.reject("malware-detected", "The file was rejected by the safety scan");
    if (input.malwareState === "unavailable") return this.reject("scanner-unavailable", "The required safety scanner is unavailable", true);
    if (bytes.byteLength === 0) return this.reject("file-empty", "The selected file is empty");
    if (bytes.byteLength > input.constraints.max_bytes) return this.reject("file-too-large", "The selected file exceeds the intake size limit");
    const mediaType = this.signature(bytes);
    if (!mediaType) return this.reject("signature-unknown", "The file signature is not a supported image or PDF");
    if (mediaType === "application/zip") return this.reject("archive-not-allowed", "Archive files cannot be uploaded here");
    if (mediaType !== input.expectedMediaType) return this.reject("signature-mismatch", "The file contents do not match the selected file type");
    const expectedFromName = this.mediaTypeFromName(input.displayName);
    if (expectedFromName && expectedFromName !== mediaType) return this.reject("extension-mismatch", "The file name does not match its contents");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (mediaType === "application/pdf") return this.pdf(bytes, digest, input.constraints);
    try {
      const parsed = mediaType === "image/png" ? this.png(bytes)
        : mediaType === "image/jpeg" ? this.jpeg(bytes)
          : this.simpleImage(mediaType, bytes);
      const pixels = parsed.width * parsed.height;
      if (!Number.isSafeInteger(pixels) || pixels > input.constraints.max_pixels) {
        return this.reject("pixel-limit-exceeded", "Image dimensions exceed the safe pixel limit");
      }
      const estimated = pixels * 4 * Math.max(1, Math.ceil(parsed.bitDepth / 8));
      if (estimated > 64 * 1024 * 1024 && estimated > bytes.byteLength * 10_000) {
        return this.reject("decompression-bomb", "The compressed file expands beyond the safe ratio");
      }
      return {
        accepted: true,
        facts: {
          schema_version: PRODUCT_SCHEMA_VERSION,
          sha256: digest,
          detected_media_type: mediaType,
          byte_size: bytes.byteLength,
          width: parsed.width,
          height: parsed.height,
          megapixels_milli: Math.floor(pixels / 1000),
          orientation: parsed.orientation,
          frame_count: parsed.frames,
          page_count: null,
          has_alpha: parsed.hasAlpha,
          bit_depth: parsed.bitDepth,
          colour_model: parsed.colourModel,
          has_icc_profile: parsed.hasIcc,
          sensitive_metadata: parsed.sensitive,
          malware_scan_state: "clean",
        },
      };
    } catch (error) {
      return this.reject("header-malformed", error instanceof Error ? error.message : "The file header is malformed");
    }
  }

  private signature(bytes: Buffer): string | null {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
    if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
    if (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return "image/tiff";
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
    if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "application/zip";
    if (bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    return null;
  }

  private png(bytes: Buffer): RasterHeaderFacts {
    if (bytes.byteLength < 33 || bytes.subarray(12, 16).toString("ascii") !== "IHDR" || bytes.readUInt32BE(8) !== 13) {
      throw new Error("PNG header is truncated or malformed");
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const bitDepth = bytes[24] ?? 0;
    const colour = bytes[25] ?? -1;
    if (width < 1 || height < 1 || ![0, 2, 3, 4, 6].includes(colour)) throw new Error("PNG dimensions or colour type are invalid");
    const header = bytes.subarray(0, Math.min(bytes.byteLength, 1024 * 1024));
    const text = header.toString("latin1");
    return {
      width, height, bitDepth,
      hasAlpha: [4, 6].includes(colour) || text.includes("tRNS"),
      hasIcc: text.includes("iCCP") || text.includes("sRGB"),
      orientation: null,
      frames: text.includes("acTL") ? 2 : 1,
      sensitive: [text.includes("eXIf") ? "exif" : null, text.includes("tEXt") ? "text" : null].filter(Boolean) as string[],
      colourModel: [0, 4].includes(colour) ? "grayscale" : colour === 3 ? "indexed" : "rgb",
    };
  }

  private jpeg(bytes: Buffer): RasterHeaderFacts {
    let offset = 2;
    let hasIcc = false;
    let orientation: number | null = null;
    const sensitive = new Set<string>();
    while (offset + 4 <= bytes.byteLength && offset < 1024 * 1024) {
      if (bytes[offset] !== 0xff) throw new Error("JPEG segment marker is malformed");
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2; continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      const end = offset + 2 + length;
      if (length < 2 || end > bytes.byteLength) throw new Error("JPEG segment is truncated");
      const payload = bytes.subarray(offset + 4, end);
      if (marker === 0xe1 && payload.subarray(0, 6).toString("latin1") === "Exif\0\0") {
        sensitive.add("exif");
        const tiff = payload.subarray(6);
        orientation = this.tiffTagValue(tiff, 0x0112);
        for (const [tag, category] of [
          [0x010e, "description"], [0x0131, "software_device"],
          [0x013b, "software_device"], [0x8298, "copyright"],
          [0x8825, "gps"], [0x927c, "maker_notes"],
          [0x0201, "embedded_thumbnails"], [0x0202, "embedded_thumbnails"],
        ] as const) {
          if (this.tiffHasTag(tiff, tag)) sensitive.add(category);
        }
      }
      if (marker === 0xe1 && payload.subarray(0, 29).toString("latin1") === "http://ns.adobe.com/xap/1.0/\0") sensitive.add("xmp");
      if (marker === 0xe2 && payload.subarray(0, 12).toString("latin1") === "ICC_PROFILE\0") hasIcc = true;
      if (marker === 0xed && payload.subarray(0, 14).toString("latin1") === "Photoshop 3.0\0") sensitive.add("iptc");
      if (marker === 0xfe) sensitive.add("comments");
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (payload.byteLength < 6) throw new Error("JPEG frame header is truncated");
        const bitDepth = payload[0] ?? 0;
        const height = payload.readUInt16BE(1);
        const width = payload.readUInt16BE(3);
        const channels = payload[5] ?? 0;
        if (width < 1 || height < 1 || ![1, 3, 4].includes(channels)) throw new Error("JPEG frame dimensions or channels are invalid");
        return {
          width, height, bitDepth, hasAlpha: false, hasIcc,
          orientation: orientation && orientation >= 1 && orientation <= 8 ? orientation : null,
          frames: 1, sensitive: [...sensitive].sort(),
          colourModel: channels === 1 ? "grayscale" : channels === 3 ? "rgb" : "cmyk",
        };
      }
      offset = end;
    }
    throw new Error("JPEG frame header was not found within the bounded header");
  }

  private simpleImage(mediaType: string, bytes: Buffer): RasterHeaderFacts {
    if (mediaType === "image/gif" && bytes.byteLength >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), bitDepth: 8, hasAlpha: false, hasIcc: false, orientation: null, frames: 1, sensitive: [], colourModel: "indexed" };
    }
    if (mediaType === "image/bmp" && bytes.byteLength >= 30) {
      const bitDepth = bytes.readUInt16LE(28);
      return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)), bitDepth, hasAlpha: bitDepth === 32, hasIcc: false, orientation: null, frames: 1, sensitive: [], colourModel: "rgb" };
    }
    if (mediaType === "image/webp") return this.webp(bytes);
    if (mediaType === "image/tiff") return this.tiff(bytes);
    throw new Error("This image container requires a separately approved parser");
  }

  private webp(bytes: Buffer): RasterHeaderFacts {
    if (bytes.byteLength < 20) throw new Error("WebP header is truncated");
    const declaredEnd = bytes.readUInt32LE(4) + 8;
    if (declaredEnd < 20 || declaredEnd > bytes.byteLength) throw new Error("WebP RIFF size is invalid");
    const boundedEnd = Math.min(declaredEnd, 1024 * 1024);
    let offset = 12;
    let width = 0;
    let height = 0;
    let hasAlpha = false;
    let hasIcc = false;
    let animationFrames = 0;
    const sensitive = new Set<string>();
    while (offset + 8 <= boundedEnd) {
      const kind = bytes.subarray(offset, offset + 4).toString("ascii");
      const size = bytes.readUInt32LE(offset + 4);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + size;
      if (payloadEnd > declaredEnd || payloadEnd > bytes.byteLength) throw new Error("WebP chunk is truncated");
      if (kind === "VP8X") {
        if (size !== 10) throw new Error("WebP extended header is malformed");
        const flags = bytes[payloadStart] ?? 0;
        width = 1 + bytes.readUIntLE(payloadStart + 4, 3);
        height = 1 + bytes.readUIntLE(payloadStart + 7, 3);
        hasAlpha ||= Boolean(flags & 0x10);
        hasIcc ||= Boolean(flags & 0x20);
        if (flags & 0x08) sensitive.add("exif");
        if (flags & 0x04) sensitive.add("xmp");
      } else if (kind === "VP8 ") {
        if (size < 10 || !bytes.subarray(payloadStart + 3, payloadStart + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
          throw new Error("WebP lossy frame header is malformed");
        }
        width = bytes.readUInt16LE(payloadStart + 6) & 0x3fff;
        height = bytes.readUInt16LE(payloadStart + 8) & 0x3fff;
      } else if (kind === "VP8L") {
        if (size < 5 || bytes[payloadStart] !== 0x2f) throw new Error("WebP lossless frame header is malformed");
        const packed = bytes.readUInt32LE(payloadStart + 1);
        width = (packed & 0x3fff) + 1;
        height = ((packed >>> 14) & 0x3fff) + 1;
        hasAlpha = true;
      } else if (kind === "ICCP") {
        hasIcc = true;
      } else if (kind === "EXIF") {
        sensitive.add("exif");
        const marker = bytes.subarray(payloadStart, Math.min(payloadEnd, payloadStart + 6)).toString("latin1");
        const tiff = bytes.subarray(payloadStart + (marker === "Exif\0\0" ? 6 : 0), payloadEnd);
        if (this.tiffHasTag(tiff, 0x8825)) sensitive.add("gps");
        if (this.tiffHasTag(tiff, 0x927c)) sensitive.add("maker_notes");
        if (this.tiffHasTag(tiff, 0x0201) || this.tiffHasTag(tiff, 0x0202)) sensitive.add("embedded_thumbnails");
      } else if (kind === "XMP ") {
        sensitive.add("xmp");
      } else if (kind === "ANMF") {
        animationFrames += 1;
      }
      offset = payloadEnd + (size & 1);
    }
    if (width < 1 || height < 1) throw new Error("WebP frame dimensions were not found in the bounded header");
    return {
      width, height, bitDepth: 8, hasAlpha, hasIcc, orientation: null,
      frames: Math.max(1, animationFrames), sensitive: [...sensitive].sort(), colourModel: "rgb",
    };
  }

  private tiff(bytes: Buffer): RasterHeaderFacts {
    if (bytes.byteLength < 8) throw new Error("TIFF header is truncated");
    const little = bytes.subarray(0, 2).toString("ascii") === "II";
    if (!little && bytes.subarray(0, 2).toString("ascii") !== "MM") throw new Error("TIFF byte order is invalid");
    const bounded = bytes.subarray(0, Math.min(bytes.byteLength, 1024 * 1024));
    const u16 = (offset: number) => {
      if (offset < 0 || offset + 2 > bounded.byteLength) throw new Error("TIFF directory is outside the bounded header");
      return little ? bounded.readUInt16LE(offset) : bounded.readUInt16BE(offset);
    };
    const u32 = (offset: number) => {
      if (offset < 0 || offset + 4 > bounded.byteLength) throw new Error("TIFF directory is outside the bounded header");
      return little ? bounded.readUInt32LE(offset) : bounded.readUInt32BE(offset);
    };
    if (u16(2) !== 42) throw new Error("TIFF version is unsupported");
    const readValues = (entry: number, valueType: number, count: number): number[] => {
      const size = ({ 1: 1, 3: 2, 4: 4 } as Record<number, number>)[valueType];
      if (!size || count < 1 || count > 16) return [];
      const total = size * count;
      const start = total <= 4 ? entry + 8 : u32(entry + 8);
      if (start + total > bounded.byteLength) throw new Error("TIFF tag value is outside the bounded header");
      return Array.from({ length: count }, (_, index) => {
        const at = start + index * size;
        if (valueType === 1) return bounded[at] ?? 0;
        return valueType === 3 ? u16(at) : u32(at);
      });
    };
    let ifd = u32(4);
    if (ifd < 8) throw new Error("TIFF first directory is invalid");
    const seen = new Set<number>();
    let firstTags: Map<number, number[]> | null = null;
    const sensitive = new Set<string>();
    let frames = 0;
    while (ifd && frames < 64) {
      if (seen.has(ifd)) throw new Error("TIFF directory chain is cyclic");
      seen.add(ifd);
      const count = u16(ifd);
      if (count > 512) throw new Error("TIFF directory contains too many tags");
      const end = ifd + 2 + count * 12;
      if (end + 4 > bounded.byteLength) throw new Error("TIFF directory is truncated");
      const tags = new Map<number, number[]>();
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        const tag = u16(entry);
        tags.set(tag, readValues(entry, u16(entry + 2), u32(entry + 4)));
        const category = new Map<number, string>([
          [270, "description"], [305, "software_device"], [315, "software_device"],
          [33432, "copyright"], [33723, "iptc"], [34665, "exif"], [34853, "gps"],
          [37500, "maker_notes"], [513, "embedded_thumbnails"],
          [514, "embedded_thumbnails"], [700, "xmp"],
        ]).get(tag);
        if (category) sensitive.add(category);
      }
      firstTags ??= tags;
      frames += 1;
      ifd = u32(end);
    }
    if (ifd) throw new Error("TIFF contains more than 64 image directories");
    for (const [tag, category] of [
      [34665, "exif"], [34853, "gps"], [37500, "maker_notes"],
      [513, "embedded_thumbnails"], [514, "embedded_thumbnails"], [700, "xmp"],
    ] as const) {
      if (this.tiffHasTag(bounded, tag)) sensitive.add(category);
    }
    const tags = firstTags ?? new Map<number, number[]>();
    const first = (tag: number, fallback = 0) => tags.get(tag)?.[0] ?? fallback;
    const width = first(256);
    const height = first(257);
    const bits = tags.get(258) ?? [1];
    const bitDepth = Math.max(...bits);
    const samples = first(277, bits.length);
    const photometric = first(262, -1);
    if (width < 1 || height < 1 || bitDepth < 1) throw new Error("TIFF dimensions or sample depth are invalid");
    const colourModel = new Map<number, SourceColourModel>([
      [0, "grayscale"], [1, "grayscale"], [2, "rgb"], [3, "indexed"], [5, "cmyk"],
    ]).get(photometric);
    if (!colourModel) throw new Error("TIFF photometric interpretation is unsupported");
    if (colourModel === "cmyk" && samples < 4) throw new Error("TIFF CMYK samples are incomplete");
    const orientationValue = first(274, 1);
    const orientation = orientationValue >= 1 && orientationValue <= 8 && orientationValue !== 1 ? orientationValue : null;
    const expectedChannels = colourModel === "cmyk" ? 4 : colourModel === "rgb" ? 3 : 1;
    return {
      width, height, bitDepth,
      hasAlpha: tags.has(338) || samples > expectedChannels,
      hasIcc: tags.has(34675), orientation, frames,
      sensitive: [...sensitive].sort(), colourModel,
    };
  }

  private tiffHasTag(tiff: Buffer, wanted: number): boolean {
    return this.tiffTagValue(tiff, wanted) !== null;
  }

  private tiffTagValue(tiff: Buffer, wanted: number): number | null {
    if (tiff.byteLength < 8) return null;
    const order = tiff.subarray(0, 2).toString("ascii");
    if (order !== "II" && order !== "MM") return null;
    const little = order === "II";
    const u16 = (offset: number) => offset + 2 <= tiff.byteLength
      ? little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset)
      : null;
    const u32 = (offset: number) => offset + 4 <= tiff.byteLength
      ? little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset)
      : null;
    const first = u32(4);
    if (first === null) return null;
    const pending = [first];
    const seen = new Set<number>();
    while (pending.length && seen.size < 64) {
      const ifd = pending.pop()!;
      if (ifd < 8 || seen.has(ifd) || ifd + 2 > tiff.byteLength) return null;
      seen.add(ifd);
      const count = u16(ifd);
      if (count === null || count > 512) return null;
      const end = ifd + 2 + count * 12;
      if (end + 4 > tiff.byteLength) return null;
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        const tag = u16(entry);
        const type = u16(entry + 2);
        const values = u32(entry + 4);
        if (tag === null || type === null || values === null) return null;
        if (tag === wanted) {
          if (values !== 1) return 1;
          if (type === 3) return u16(entry + 8);
          if (type === 4) return u32(entry + 8);
          return 1;
        }
        if ([0x8769, 0x8825, 0xa005].includes(tag) && type === 4 && values === 1) {
          const child = u32(entry + 8);
          if (child) pending.push(child);
        }
      }
      const following = u32(end);
      if (following) pending.push(following);
    }
    return null;
  }

  private pdf(bytes: Buffer, digest: string, constraints: UploadConstraints): InspectionOutcome {
    if (!bytes.subarray(Math.max(0, bytes.byteLength - 4096)).includes(Buffer.from("%%EOF"))) {
      return this.reject("pdf-truncated", "The PDF is incomplete or corrupt");
    }
    const body = bytes.toString("latin1");
    if (["/JavaScript", "/JS", "/Launch", "/EmbeddedFile", "/RichMedia", "/OpenAction"].some((value) => body.includes(value))) {
      return this.reject("pdf-dangerous-structure", "The PDF contains active or embedded content");
    }
    const pages = body.match(/\/Type\s*\/Page(?!s)\b/g)?.length ?? 0;
    if (pages < 1) return this.reject("pdf-pages-missing", "No readable PDF pages were found");
    if (pages > constraints.max_pages) return this.reject("pdf-page-limit-exceeded", "The PDF has too many pages for safe intake");
    return {
      accepted: true,
      facts: {
        schema_version: PRODUCT_SCHEMA_VERSION, sha256: digest, detected_media_type: "application/pdf",
        byte_size: bytes.byteLength, width: null, height: null, megapixels_milli: null, orientation: null,
        frame_count: null, page_count: pages, has_alpha: null, bit_depth: null, colour_model: null, has_icc_profile: null,
        sensitive_metadata: body.includes("/Encrypt") ? ["encrypted"] : [], malware_scan_state: "clean",
      },
    };
  }

  private mediaTypeFromName(name: string): string | null {
    const extension = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff", ".pdf": "application/pdf" } as Record<string, string>)[extension ?? ""] ?? null;
  }

  private reject(code: string, message: string, retryable = false): InspectionOutcome {
    return { accepted: false, failure: { schema_version: PRODUCT_SCHEMA_VERSION, code, message, retryable } };
  }
}

export const MALWARE_SCANNER = Symbol("MALWARE_SCANNER");
export const INSPECTION_ADAPTER = Symbol("INSPECTION_ADAPTER");
