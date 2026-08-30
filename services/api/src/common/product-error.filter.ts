import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class ProductErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ headers: Record<string, string | undefined> }>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = exception instanceof Error ? exception.message : "Unexpected error";

    response.status(status).json({
      error: {
        code: status === 404 ? "not-found" : "request-failed",
        message,
        trace_id: request.headers["x-trace-id"] ?? "trace-unset",
      },
    });
  }
}
