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
        database: process.env["IPW_DATABASE_URL"] ? "postgresql" : "deterministic_local",
        queue: "excluded_recovery_2a",
        object_storage: "reference_catalog_only",
      },
      trace_id: traceId ?? "trace-unset",
    };
  }
}
