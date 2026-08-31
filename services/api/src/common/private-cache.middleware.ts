import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

@Injectable()
export class PrivateCacheMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction) {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Vary", "Cookie, Authorization");
    next();
  }
}
