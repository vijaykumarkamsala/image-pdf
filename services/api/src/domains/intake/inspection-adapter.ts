import { createHash } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { IntakeFailure, SourceFacts, UploadConstraints } from "ipw-contracts-ts/product";

export interface InspectionOutcome {
  accepted: boolean;
  facts?: SourceFacts;
  failure?: IntakeFailure;
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
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
    if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "application/zip";
    if (bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    return null;
  }

  private png(bytes: Buffer) {
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
    };
  }

  private jpeg(bytes: Buffer) {
    let offset = 2;
    let hasIcc = false;
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
      if (marker === 0xe1 && payload.subarray(0, 6).toString("latin1") === "Exif\0\0") sensitive.add("exif");
      if (marker === 0xe2 && payload.subarray(0, 12).toString("latin1") === "ICC_PROFILE\0") hasIcc = true;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (payload.byteLength < 6) throw new Error("JPEG frame header is truncated");
        const bitDepth = payload[0] ?? 0;
        const height = payload.readUInt16BE(1);
        const width = payload.readUInt16BE(3);
        if (width < 1 || height < 1) throw new Error("JPEG frame dimensions are invalid");
        return { width, height, bitDepth, hasAlpha: false, hasIcc, orientation: null, frames: 1, sensitive: [...sensitive] };
      }
      offset = end;
    }
    throw new Error("JPEG frame header was not found within the bounded header");
  }

  private simpleImage(mediaType: string, bytes: Buffer) {
    if (mediaType === "image/gif" && bytes.byteLength >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), bitDepth: 8, hasAlpha: false, hasIcc: false, orientation: null, frames: 1, sensitive: [] };
    }
    if (mediaType === "image/bmp" && bytes.byteLength >= 30) {
      const bitDepth = bytes.readUInt16LE(28);
      return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)), bitDepth, hasAlpha: bitDepth === 32, hasIcc: false, orientation: null, frames: 1, sensitive: [] };
    }
    if (mediaType === "image/webp" && bytes.byteLength >= 30 && bytes.subarray(12, 16).toString("ascii") === "VP8X") {
      const flags = bytes[20] ?? 0;
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), bitDepth: 8, hasAlpha: Boolean(flags & 0x10), hasIcc: Boolean(flags & 0x20), orientation: null, frames: flags & 0x02 ? 2 : 1, sensitive: [] };
    }
    throw new Error("This image container requires a separately approved parser");
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
        frame_count: null, page_count: pages, has_alpha: null, bit_depth: null, has_icc_profile: null,
        sensitive_metadata: body.includes("/Encrypt") ? ["encrypted"] : [], malware_scan_state: "clean",
      },
    };
  }

  private mediaTypeFromName(name: string): string | null {
    const extension = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp", ".pdf": "application/pdf" } as Record<string, string>)[extension ?? ""] ?? null;
  }

  private reject(code: string, message: string, retryable = false): InspectionOutcome {
    return { accepted: false, failure: { schema_version: PRODUCT_SCHEMA_VERSION, code, message, retryable } };
  }
}

export const MALWARE_SCANNER = Symbol("MALWARE_SCANNER");
export const INSPECTION_ADAPTER = Symbol("INSPECTION_ADAPTER");
