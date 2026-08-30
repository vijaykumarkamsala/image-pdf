import { Controller, Get, Headers } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("health")
  health(@Headers("x-trace-id") traceId?: string) {
    return {
      ok: true,
      service: "ipw-api",
      version: "v1",
      trace_id: traceId ?? "trace-unset",
    };
  }

  @Get("ready")
  ready(@Headers("x-trace-id") traceId?: string) {
    return {
      ok: true,
      service: "ipw-api",
      dependencies: {
        database: "deferred",
        queue: "deferred",
        object_storage: "deferred",
      },
      trace_id: traceId ?? "trace-unset",
    };
  }
}
