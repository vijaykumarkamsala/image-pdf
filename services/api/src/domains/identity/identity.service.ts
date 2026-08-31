import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createHash } from "node:crypto";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import type { Principal } from "../../kernel/product.types.js";
import { AUTH_REPOSITORY, type AuthRepository, type StoredApplicationSession } from "./auth.types.js";
import { cookieValue, SESSION_COOKIE } from "./cookies.js";

type HeaderValue = string | string[] | undefined;

@Injectable()
export class IdentityBoundary implements OnApplicationShutdown {
  constructor(@Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository) {}

  async resolve(headers: Record<string, HeaderValue>): Promise<Principal> {
    const authenticated = await this.session(headers);
    if (authenticated) return authenticated.principal;

    const rawActor = headers["x-ipw-test-actor-id"];
    const rawName = headers["x-ipw-test-actor-name"];
    const actorValue = Array.isArray(rawActor) ? rawActor[0] : rawActor;
    const nameValue = Array.isArray(rawName) ? rawName[0] : rawName;
    if (process.env["NODE_ENV"] === "test" && actorValue) return {
      actorId: requireId(actorValue, "test actor id"),
      displayName: requireText(nameValue ?? actorValue, "test actor name"),
    };
    throw new DomainError(401, "authentication-required", "Sign in is required");
  }

  async session(headers: Record<string, HeaderValue>): Promise<StoredApplicationSession | null> {
    const token = cookieValue(headers, SESSION_COOKIE);
    if (!token) return null;
    return this.repository.findSession(createHash("sha256").update(token).digest("hex"), new Date().toISOString());
  }

  async onApplicationShutdown(): Promise<void> { await this.repository.close(); }
}
