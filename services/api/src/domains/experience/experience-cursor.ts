import { DomainError } from "../../kernel/errors.js";

export interface ExperienceCursor {
  occurredAt: string;
  resourceId: string;
  kind?: string;
}

export function encodeExperienceCursor(value: ExperienceCursor): string {
  return Buffer.from(JSON.stringify([value.occurredAt, value.resourceId, value.kind ?? null]), "utf8").toString("base64url");
}

export function decodeExperienceCursor(value?: string): ExperienceCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string" || (parsed[2] !== null && typeof parsed[2] !== "string")) {
      throw new Error("shape");
    }
    if (Number.isNaN(Date.parse(parsed[0])) || !parsed[1]) throw new Error("value");
    return { occurredAt: parsed[0], resourceId: parsed[1], kind: parsed[2] ?? undefined };
  } catch {
    throw new DomainError(400, "page-cursor-invalid", "Use a valid pagination cursor");
  }
}
