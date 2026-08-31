import { Body, Controller, Get, Headers, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { ProductKernelService } from "../../kernel/kernel.service.js";
import { AuthService, type IssuedSession } from "./auth.service.js";
import { CSRF_COOKIE, expiredCookie, GUEST_COOKIE, secureCookie, SESSION_COOKIE } from "./cookies.js";

@Controller()
export class IdentityController {
  constructor(private readonly kernel: ProductKernelService, private readonly auth: AuthService) {}

  @Post("session/bootstrap")
  bootstrap(@Headers() headers: Record<string, string | string[] | undefined>) {
    return this.kernel.bootstrap(headers);
  }

  @Get("auth/login")
  async login(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query("return_to") returnTo: string | undefined,
    @Query("handoff") handoff: string | undefined,
    @Res() response: Response,
  ) {
    response.redirect(302, await this.auth.login(headers, returnTo, handoff));
  }

  @Get("auth/callback")
  async callback(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() response: Response,
  ) {
    try {
      const completed = await this.auth.callback(headers, code, state);
      this.setSession(response, completed.issued);
      response.redirect(302, completed.redirectTo);
    } catch {
      response.redirect(302, "/guest/upload?sign_in=failed");
    }
  }

  @Get("auth/session")
  async session(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const current = await this.auth.current(headers);
    if (!current.authenticated) return { authenticated: false };
    if (current.issued) this.setSession(response, current.issued);
    return {
      authenticated: true,
      actor: { actor_id: current.session.principal.actorId, display_name: current.session.principal.displayName },
      expires_at: current.session.expiresAt,
    };
  }

  @Post("auth/logout")
  async logout(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(headers);
    response.appendHeader("Set-Cookie", expiredCookie(SESSION_COOKIE));
    response.appendHeader("Set-Cookie", expiredCookie(GUEST_COOKIE));
    response.appendHeader("Set-Cookie", expiredCookie(CSRF_COOKIE, false));
    response.setHeader("Cache-Control", "no-store");
    return { authenticated: false };
  }

  @Post("auth/developer-session")
  async developerSession(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) response: Response) {
    const issued = await this.auth.developerSession(body);
    this.setSession(response, issued);
    return { authenticated: true, actor: { actor_id: issued.session.principal.actorId, display_name: issued.session.principal.displayName }, expires_at: issued.session.expiresAt };
  }

  private setSession(response: Response, issued: IssuedSession) {
    const maxAge = Math.max(0, Math.floor((new Date(issued.session.expiresAt).getTime() - Date.now()) / 1000));
    response.appendHeader("Set-Cookie", secureCookie(SESSION_COOKIE, issued.sessionToken, maxAge));
    response.appendHeader("Set-Cookie", secureCookie(CSRF_COOKIE, issued.csrfToken, maxAge, false));
    response.setHeader("Cache-Control", "no-store");
  }
}
