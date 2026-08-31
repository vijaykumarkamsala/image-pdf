import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

import { DomainError } from "../kernel/errors.js";
import { constantTimeEqual, cookieValue, CSRF_COOKIE, GUEST_COOKIE, SESSION_COOKIE } from "../domains/identity/cookies.js";

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction) {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    const path = request.path.replace(/^\/v1/, "");
    if (path === "/guest-sessions") return next();
    const headers = request.headers as Record<string, string | string[] | undefined>;
    if (!cookieValue(headers, SESSION_COOKIE) && !cookieValue(headers, GUEST_COOKIE)) return next();
    const cookie = cookieValue(headers, CSRF_COOKIE);
    const supplied = request.header("x-csrf-token")?.trim();
    if (!cookie || !supplied || !constantTimeEqual(cookie, supplied)) {
      throw new DomainError(403, "csrf-invalid", "This browser session could not be verified");
    }
    next();
  }
}
