import { createHash, randomUUID } from "node:crypto";

export interface RuntimeValues {
  id(prefix: string): string;
  now(): string;
}

export class SystemRuntimeValues implements RuntimeValues {
  id(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}

export class DeterministicRuntimeValues implements RuntimeValues {
  private sequence = 0;

  constructor(private readonly instant = "2026-08-30T00:00:00.000Z") {}

  id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(6, "0")}`;
  }

  now(): string {
    return this.instant;
  }
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
