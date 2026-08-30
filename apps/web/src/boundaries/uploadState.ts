import type { ProcessingJobRecord, UploadSessionRecord } from "ipw-contracts-ts/product";

export type UploadPhase =
  | "selecting"
  | "authorising"
  | "uploading"
  | "queued"
  | "inspecting"
  | "ready"
  | "rejected"
  | "cancelled"
  | "error";

export interface ActiveUploadReference {
  uploadSessionId: string;
  jobId: string;
  displayName: string;
  traceId: string;
}

export interface UploadPresentation {
  title: string;
  description: string;
  progress: number;
}

const presentations: Record<UploadPhase, Omit<UploadPresentation, "progress">> = {
  selecting: { title: "Upload a file", description: "Choose an image or PDF to add to Default Files." },
  authorising: { title: "Preparing upload", description: "Creating a private upload session." },
  uploading: { title: "Uploading securely", description: "Keep this window open while the file is transferred." },
  queued: { title: "Waiting for inspection", description: "Your file is safely queued for quality and security checks." },
  inspecting: { title: "Checking your file", description: "Verifying the file type, safety and source details." },
  ready: { title: "File ready", description: "Your original is preserved and now appears in Default Files." },
  rejected: { title: "File not accepted", description: "The file did not pass the required safety or format checks." },
  cancelled: { title: "Upload cancelled", description: "The upload was cancelled and its temporary data was removed." },
  error: { title: "Upload interrupted", description: "The upload could not be completed. You can try again." },
};

export function presentationFor(phase: UploadPhase, progress = 0): UploadPresentation {
  return { ...presentations[phase], progress: Math.max(0, Math.min(100, Math.round(progress))) };
}

export function phaseFromRecords(job: ProcessingJobRecord, upload: UploadSessionRecord): UploadPhase {
  if (upload.state === "ready" || job.state === "succeeded") return "ready";
  if (upload.state === "rejected" || job.state === "failed") return "rejected";
  if (upload.state === "cancelled" || job.state === "cancelled") return "cancelled";
  if (job.state === "leased" || job.state === "running" || upload.state === "inspecting") return "inspecting";
  return "queued";
}

export function mediaTypeFor(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase();
  return ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    tif: "image/tiff",
    tiff: "image/tiff",
    bmp: "image/bmp",
    heif: "image/heif",
    heic: "image/heic",
    pdf: "application/pdf",
  } as Record<string, string>)[extension ?? ""] ?? "";
}

export function nextGcsOffset(status: number, range: string | null, totalBytes: number): number {
  if (status >= 200 && status < 300) return totalBytes;
  if (status !== 308) throw new Error("The file transfer was interrupted");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range.trim());
  const last = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(last) || last < 0 || last >= totalBytes) {
    throw new Error("The storage provider returned an invalid resume position");
  }
  return last + 1;
}

export function parseActiveUpload(value: string | null): ActiveUploadReference | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<ActiveUploadReference>;
    if (
      typeof candidate.uploadSessionId === "string"
      && typeof candidate.jobId === "string"
      && typeof candidate.displayName === "string"
      && typeof candidate.traceId === "string"
    ) return candidate as ActiveUploadReference;
  } catch {
    return null;
  }
  return null;
}
