import type { Principal } from "../../kernel/product.types.js";

export interface AuthTransaction {
  stateHash: string;
  nonceHash: string;
  codeVerifier: string;
  returnTo: string;
  handoffUploadSessionId: string | null;
  guestTokenHash: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface StoredApplicationSession {
  sessionIdHash: string;
  principal: Principal;
  createdAt: string;
  expiresAt: string;
  rotateAfter: string;
  lastSeenAt: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  displayName: string;
}

export interface IdentityAuditInput {
  actorId: string | null;
  action: string;
  outcome: "succeeded" | "failed";
  subjectReference: string | null;
  occurredAt: string;
  traceId: string;
}

export interface AuthRepository {
  createTransaction(transaction: AuthTransaction): Promise<void>;
  consumeTransaction(stateHash: string, now: string): Promise<AuthTransaction | null>;
  resolveIdentity(identity: OidcIdentity, actorId: string, now: string): Promise<Principal>;
  createSession(session: StoredApplicationSession): Promise<void>;
  findSession(sessionIdHash: string, now: string): Promise<StoredApplicationSession | null>;
  rotateSession(previousHash: string, session: StoredApplicationSession, now: string): Promise<boolean>;
  revokeSession(sessionIdHash: string, now: string): Promise<StoredApplicationSession | null>;
  recordAudit(input: IdentityAuditInput): Promise<void>;
  close(): Promise<void>;
}

export interface OidcAuthorizationInput {
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface OidcExchangeInput {
  code: string;
  codeVerifier: string;
  expectedNonceHash: string;
}

export interface OidcProvider {
  authorizationUrl(input: OidcAuthorizationInput): Promise<string>;
  exchange(input: OidcExchangeInput): Promise<OidcIdentity>;
}

export const AUTH_REPOSITORY = Symbol("AUTH_REPOSITORY");
export const OIDC_PROVIDER = Symbol("OIDC_PROVIDER");
