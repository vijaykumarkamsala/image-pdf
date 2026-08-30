import type { TraceContext } from "ipw-contracts-ts";

export interface ApiClient {
  readonly trace: TraceContext;
  get<T>(path: string): Promise<T>;
}

export function createApiClient(trace: TraceContext): ApiClient {
  return {
    trace,
    async get<T>(_path: string): Promise<T> {
      throw new Error("API transport is deferred until the control plane contract is approved.");
    },
  };
}
