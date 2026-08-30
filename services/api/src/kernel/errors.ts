export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new DomainError(400, "invalid-input", `${field} must be between 1 and ${max} characters`);
  }
  return value.trim();
}

export function requireId(value: unknown, field: string): string {
  const text = requireText(value, field, 64);
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(text)) {
    throw new DomainError(400, "invalid-input", `${field} is not a valid identifier`);
  }
  return text;
}

export function requireSha256(value: unknown): string {
  const text = requireText(value, "sha256", 64);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new DomainError(400, "invalid-input", "sha256 must be lower-case hexadecimal");
  }
  return text;
}

export function requireByteSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new DomainError(400, "invalid-input", "byteSize must be a non-negative safe integer");
  }
  return Number(value);
}
