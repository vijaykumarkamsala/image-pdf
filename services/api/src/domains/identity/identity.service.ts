import { Injectable } from "@nestjs/common";

import { DomainError, requireId, requireText } from "../../kernel/errors.js";
import type { Principal } from "../../kernel/product.types.js";

type HeaderValue = string | string[] | undefined;

@Injectable()
export class IdentityBoundary {
  resolve(headers: Record<string, HeaderValue>): Principal {
    const rawActor = headers["x-ipw-actor-id"];
    const rawName = headers["x-ipw-actor-name"];
    const actorValue = Array.isArray(rawActor) ? rawActor[0] : rawActor;
    const nameValue = Array.isArray(rawName) ? rawName[0] : rawName;

    if (!actorValue) {
      if (process.env["NODE_ENV"] === "production") {
        throw new DomainError(401, "authentication-required", "Sign in is required");
      }
      return { actorId: "actor-local", displayName: "Local workspace" };
    }

    return {
      actorId: requireId(actorValue, "actor id"),
      displayName: requireText(nameValue ?? actorValue, "actor name"),
    };
  }
}
