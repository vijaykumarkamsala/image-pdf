import { ConsoleLogger, type LogLevel } from "@nestjs/common";

const SECRET_KEYS = /authorization|cookie|token|secret|password|credential|key/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, SECRET_KEYS.test(key) ? "[redacted]" : redact(entry)]),
    );
  }
  return value;
}

export class SensitiveLogger extends ConsoleLogger {
  override log(message: unknown, context?: string) {
    super.log(redact(message), context);
  }

  override error(message: unknown, stackOrContext?: string, context?: string) {
    super.error(redact(message), stackOrContext, context);
  }

  override warn(message: unknown, context?: string) {
    super.warn(redact(message), context);
  }

  setLogLevels(levels: LogLevel[]) {
    super.setLogLevels(levels);
  }
}
