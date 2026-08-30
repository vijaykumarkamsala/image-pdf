import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    const incoming = request.header("x-trace-id");
    const traceId = incoming && incoming.trim() ? incoming.trim() : "trace-recovery-1";
    request.headers["x-trace-id"] = traceId;
    response.setHeader("x-trace-id", traceId);
    next();
  }
}
