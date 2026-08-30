import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    const incoming = request.header("x-trace-id")?.trim();
    const traceId = incoming && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(incoming)
      ? incoming
      : `trace-${randomUUID()}`;
    request.headers["x-trace-id"] = traceId;
    response.setHeader("x-trace-id", traceId);
    next();
  }
}
