import { ConsoleLogger, type LogLevel } from "@nestjs/common";

const SECRET_KEYS = /authorization|cookie|token|secret|password|credential|(?:^|_)key$|url|uri|path/i;
const PROTECTED_QUERY = /([?&](?:[^=&#]*(?:token|signature|credential|upload|auth|secret|x-goog)[^=&#]*)=)[^&#\s]*/gi;
const AUTHORIZATION = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const STORAGE_PATH = /\b(?:gs:\/\/[^\s"'<>]+|(?:quarantine|immutable|uploads?)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)/gi;

function protectString(value: string): string {
  return value
    .replace(AUTHORIZATION, "$1 [redacted]")
    .replace(PROTECTED_QUERY, "$1[redacted]")
    .replace(STORAGE_PATH, "[protected-storage-path]");
}

export function redactProtected(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return protectString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactProtected(entry, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    if (value instanceof Error) {
      return {
        name: value.name,
        message: protectString(value.message),
        stack: value.stack ? protectString(value.stack) : undefined,
        cause: redactProtected(value.cause, seen),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEYS.test(key) ? "[redacted]" : redactProtected(entry, seen),
      ]),
    );
  }
  return value;
}

export class SensitiveLogger extends ConsoleLogger {
  override log(message: unknown, context?: string) {
    super.log(redactProtected(message), context);
  }

  override error(message: unknown, stackOrContext?: string, context?: string) {
    super.error(
      redactProtected(message),
      stackOrContext ? protectString(stackOrContext) : undefined,
      context,
    );
  }

  override warn(message: unknown, context?: string) {
    super.warn(redactProtected(message), context);
  }

  setLogLevels(levels: LogLevel[]) {
    super.setLogLevels(levels);
  }
}
