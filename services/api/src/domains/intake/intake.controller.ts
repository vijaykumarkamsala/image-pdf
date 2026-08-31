import { Body, Controller, Delete, Get, Headers, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import { DomainError } from "../../kernel/errors.js";
import { IntakeService } from "./intake.service.js";
import { CSRF_COOKIE, expiredCookie, GUEST_COOKIE, secureCookie } from "../identity/cookies.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

@Controller()
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Post("guest-sessions")
  async createGuest(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: Response) {
    const created = await this.intake.createGuestSession(headers);
    const maxAge = Math.max(0, Math.floor((new Date(created.authorization.guest_session.expires_at).getTime() - Date.now()) / 1000));
    response.appendHeader("Set-Cookie", secureCookie(GUEST_COOKIE, created.token, maxAge));
    response.appendHeader("Set-Cookie", secureCookie(CSRF_COOKIE, created.csrfToken, maxAge, false));
    response.setHeader("Cache-Control", "no-store");
    return process.env["NODE_ENV"] === "test"
      ? { ...created.authorization, token: created.token }
      : created.authorization;
  }

  @Post("workspaces/:workspaceId/upload-sessions")
  createForWorkspace(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.intake.createForWorkspace(headers, workspaceId, body);
  }

  @Post("guest/upload-sessions")
  createForGuest(@Headers() headers: RequestHeaders, @Body() body: Record<string, unknown>) {
    return this.intake.createForGuest(headers, body);
  }

  @Get("upload-sessions/:uploadSessionId")
  get(@Headers() headers: RequestHeaders, @Param("uploadSessionId") uploadSessionId: string) {
    return this.intake.get(headers, uploadSessionId);
  }

  @Get("upload-sessions/:uploadSessionId/intake-presentation")
  presentation(@Headers() headers: RequestHeaders, @Param("uploadSessionId") uploadSessionId: string) {
    return this.intake.presentation(headers, uploadSessionId);
  }

  @Put("upload-sessions/:uploadSessionId/classification")
  correctClassification(
    @Headers() headers: RequestHeaders,
    @Param("uploadSessionId") uploadSessionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.intake.correctClassification(headers, uploadSessionId, body);
  }

  @Post("upload-sessions/:uploadSessionId/resume")
  resume(@Headers() headers: RequestHeaders, @Param("uploadSessionId") uploadSessionId: string) {
    return this.intake.resume(headers, uploadSessionId);
  }

  @Delete("upload-sessions/:uploadSessionId")
  cancel(@Headers() headers: RequestHeaders, @Param("uploadSessionId") uploadSessionId: string) {
    return this.intake.cancel(headers, uploadSessionId);
  }

  @Post("upload-sessions/:uploadSessionId/handoff")
  async handoff(
    @Headers() headers: RequestHeaders,
    @Param("uploadSessionId") uploadSessionId: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.intake.handoffGuest(headers, uploadSessionId, body);
    response.appendHeader("Set-Cookie", expiredCookie(GUEST_COOKIE));
    response.setHeader("Cache-Control", "no-store");
    return result;
  }

  @Put("uploads/:uploadSessionId/content")
  async upload(
    @Req() request: Request,
    @Param("uploadSessionId") uploadSessionId: string,
    @Query("token") token: string,
    @Headers("content-type") contentType: string | undefined,
    @Headers("upload-offset") rawOffset: string | undefined,
  ) {
    const offset = Number(rawOffset ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new DomainError(400, "upload-offset-invalid", "Upload-Offset must be a non-negative integer");
    }
    const body = await this.readBody(request, 100 * 1024 * 1024);
    return this.intake.uploadBytes(uploadSessionId, token, contentType, offset, body);
  }

  private async readBody(request: Request, limit: number): Promise<Uint8Array> {
    if (Buffer.isBuffer(request.body)) {
      if (request.body.byteLength > limit) throw new DomainError(413, "upload-too-large", "The selected file is too large");
      return request.body;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += value.byteLength;
      if (size > limit) throw new DomainError(413, "upload-too-large", "The selected file is too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}
