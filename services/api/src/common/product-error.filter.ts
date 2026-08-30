import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";

import { DomainError } from "../kernel/errors.js";

@Catch()
export class ProductErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ headers: Record<string, string | undefined> }>();
    const status = exception instanceof DomainError
      ? exception.status
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = exception instanceof DomainError
      ? exception.code
      : status === 404
        ? "not-found"
        : "request-failed";
    const message = exception instanceof DomainError
      ? exception.message
      : status < 500
        ? "The request could not be completed"
        : "The service could not complete the request";

    response.status(status).json({
      schema_version: "1.7.0",
      error: {
        schema_version: "1.7.0",
        code,
        message,
        trace_id: request.headers["x-trace-id"] ?? "trace-unset",
      },
    });
  }
}
