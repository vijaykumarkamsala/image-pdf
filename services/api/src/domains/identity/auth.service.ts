import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import { PRODUCT_REPOSITORY, type ProductKernelRepository } from "../../kernel/product.types.js";
import { requestDigest } from "../../kernel/runtime.js";
import { AUTH_REPOSITORY, OIDC_PROVIDER, type AuthRepository, type OidcProvider, type StoredApplicationSession } from "./auth.types.js";
import { constantTimeEqual, cookieValue, GUEST_COOKIE, SESSION_COOKIE } from "./cookies.js";

type Headers = Record<string, string | string[] | undefined>;
const SESSION_SECONDS = 8 * 60 * 60;
const ROTATION_SECONDS = 30 * 60;

export interface IssuedSession {
  sessionToken: string;
  csrfToken: string;
  session: StoredApplicationSession;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(OIDC_PROVIDER) private readonly provider: OidcProvider,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
  ) {}

  async login(headers: Headers, returnToValue: string | undefined, handoffValue: string | undefined): Promise<string> {
    const state = token();
    const nonce = token();
    const verifier = token(64);
    const now = new Date();
    const guestToken = cookieValue(headers, GUEST_COOKIE);
    await this.repository.createTransaction({
      stateHash: hash(state), nonceHash: hash(nonce), codeVerifier: verifier,
      returnTo: safeReturnTo(returnToValue),
      handoffUploadSessionId: handoffValue ? requireId(handoffValue, "handoff upload session id") : null,
      guestTokenHash: guestToken ? hash(guestToken) : null,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
    return this.provider.authorizationUrl({ state, nonce, codeChallenge: base64UrlDigest(verifier) });
  }

  async callback(headers: Headers, codeValue: string | undefined, stateValue: string | undefined): Promise<{ issued: IssuedSession; redirectTo: string }> {
    const traceId = header(headers, "x-trace-id") ?? `trace-${randomUUID()}`;
    try {
      const state = requireText(stateValue, "OIDC state");
      const transaction = await this.repository.consumeTransaction(hash(state), new Date().toISOString());
      if (!transaction) throw new DomainError(401, "oidc-state-invalid", "Sign in request expired or was already used");
      const currentGuest = cookieValue(headers, GUEST_COOKIE);
      if (transaction.guestTokenHash && (!currentGuest || !constantHash(currentGuest, transaction.guestTokenHash))) {
        throw new DomainError(401, "guest-handoff-context-invalid", "Temporary work could not be matched to this sign-in");
      }
      const identity = await this.provider.exchange({
        code: requireText(codeValue, "OIDC code"), codeVerifier: transaction.codeVerifier,
        expectedNonceHash: transaction.nonceHash,
      });
      const principal = await this.repository.resolveIdentity(identity, `actor-${randomUUID()}`, new Date().toISOString());
      const previous = cookieValue(headers, SESSION_COOKIE);
      if (previous) await this.repository.revokeSession(hash(previous), new Date().toISOString());
      const issued = await this.issue(principal);
      await this.product.bootstrap({
        principal,
        idempotencyKey: `auth-bootstrap-${principal.actorId}`,
        traceId,
        requestHash: requestDigest({ command: "auth.bootstrap", actorId: principal.actorId }),
      });
      await this.repository.recordAudit({ actorId: principal.actorId, action: "identity.login", outcome: "succeeded", subjectReference: identity.issuer, occurredAt: new Date().toISOString(), traceId });
      const redirect = transaction.handoffUploadSessionId
        ? `/auth/complete?handoff=${encodeURIComponent(transaction.handoffUploadSessionId)}&return_to=${encodeURIComponent(transaction.returnTo)}`
        : transaction.returnTo;
      return { issued, redirectTo: redirect };
    } catch (error) {
      await this.repository.recordAudit({ actorId: null, action: "identity.login", outcome: "failed", subjectReference: null, occurredAt: new Date().toISOString(), traceId });
      throw error;
    }
  }

  async current(headers: Headers): Promise<{ authenticated: false } | { authenticated: true; issued?: IssuedSession; session: StoredApplicationSession }> {
    const raw = cookieValue(headers, SESSION_COOKIE);
    if (!raw) return { authenticated: false };
    const current = await this.repository.findSession(hash(raw), new Date().toISOString());
    if (!current) return { authenticated: false };
    if (current.rotateAfter > new Date().toISOString()) return { authenticated: true, session: current };
    const issued = await this.issue(current.principal, current.createdAt, false);
    if (!await this.repository.rotateSession(hash(raw), issued.session, new Date().toISOString())) return { authenticated: false };
    return { authenticated: true, session: issued.session, issued };
  }

  async logout(headers: Headers): Promise<void> {
    const raw = cookieValue(headers, SESSION_COOKIE);
    if (!raw) return;
    const now = new Date().toISOString();
    const session = await this.repository.revokeSession(hash(raw), now);
    if (session) await this.repository.recordAudit({ actorId: session.principal.actorId, action: "identity.logout", outcome: "succeeded", subjectReference: null, occurredAt: now, traceId: header(headers, "x-trace-id") ?? `trace-${randomUUID()}` });
  }

  async developerSession(body: Record<string, unknown>): Promise<IssuedSession> {
    if (process.env["NODE_ENV"] === "production" || process.env["IPW_DEV_IDENTITY_ENABLED"] !== "1") {
      throw new DomainError(404, "not-found", "The requested route is unavailable");
    }
    const actorId = requireId(body["actor_id"], "actor id");
    const displayName = requireText(body["display_name"] ?? actorId, "display name");
    const principal = await this.repository.resolveIdentity(
      { issuer: "urn:ipw:developer", subject: actorId, displayName }, actorId, new Date().toISOString(),
    );
    const issued = await this.issue(principal);
    await this.product.bootstrap({ principal, idempotencyKey: `dev-bootstrap-${actorId}`, traceId: `trace-${actorId}`, requestHash: requestDigest({ command: "developer.bootstrap", actorId }) });
    return issued;
  }

  private async issue(principal: { actorId: string; displayName: string }, originalCreatedAt?: string, persist = true): Promise<IssuedSession> {
    const now = new Date();
    const sessionToken = token();
    const csrfToken = token();
    const session: StoredApplicationSession = {
      sessionIdHash: hash(sessionToken), principal,
      createdAt: originalCreatedAt ?? now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString(),
      rotateAfter: new Date(now.getTime() + ROTATION_SECONDS * 1000).toISOString(),
      lastSeenAt: now.toISOString(),
    };
    if (persist) await this.repository.createSession(session);
    return { sessionToken, csrfToken, session };
  }
}

function token(bytes = 32): string { return randomBytes(bytes).toString("base64url"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function base64UrlDigest(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function constantHash(raw: string, expected: string): boolean { return constantTimeEqual(hash(raw), expected); }
function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/v1/")) return "/app";
  return value.slice(0, 2048);
}
function header(headers: Headers, name: string): string | null {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}
