import type { TraceContext } from "ipw-contracts-ts";

export function initialTrace(): TraceContext {
  return {
    schema_version: "1.6.0",
    trace_id: "trace-recovery-1",
  };
}
