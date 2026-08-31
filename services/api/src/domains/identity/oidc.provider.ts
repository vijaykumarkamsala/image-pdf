import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

import { DomainError } from "../../kernel/errors.js";
import { constantTimeEqual } from "./cookies.js";
import type { OidcExchangeInput, OidcIdentity, OidcProvider } from "./auth.types.js";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

export function loadOidcConfig(env: NodeJS.ProcessEnv): OidcConfig | null {
  const values = {
    issuer: env["IPW_OIDC_ISSUER"]?.replace(/\/$/, ""),
    clientId: env["IPW_OIDC_CLIENT_ID"],
    clientSecret: env["IPW_OIDC_CLIENT_SECRET"],
    redirectUri: env["IPW_OIDC_REDIRECT_URI"],
  };
  if (!values.issuer && !values.clientId && !values.clientSecret && !values.redirectUri) {
    if (env["NODE_ENV"] === "production") throw new Error("OIDC configuration is required in production");
    return null;
  }
  if (!values.issuer || !values.clientId || !values.clientSecret || !values.redirectUri) {
    throw new Error("IPW_OIDC_ISSUER, IPW_OIDC_CLIENT_ID, IPW_OIDC_CLIENT_SECRET and IPW_OIDC_REDIRECT_URI are required together");
  }
  const issuer = new URL(values.issuer);
  const redirect = new URL(values.redirectUri);
  if (env["NODE_ENV"] === "production" && (issuer.protocol !== "https:" || redirect.protocol !== "https:")) {
    throw new Error("Production OIDC issuer and redirect URI must use HTTPS");
  }
  return values as OidcConfig;
}

export class DiscoveryOidcProvider implements OidcProvider {
  private discoveryValue: DiscoveryDocument | null = null;
  private jwksValue: JSONWebKeySet | null = null;

  constructor(
    private readonly config: OidcConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const discovery = await this.discovery();
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: "openid profile email",
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchange(input: OidcExchangeInput): Promise<OidcIdentity> {
    const discovery = await this.discovery();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: input.codeVerifier,
    });
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    if (discovery.token_endpoint_auth_methods_supported?.includes("client_secret_basic") !== false) {
      headers.set("authorization", `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`);
    } else {
      form.set("client_secret", this.config.clientSecret);
    }
    const response = await this.fetcher(discovery.token_endpoint, { method: "POST", headers, body: form });
    if (!response.ok) throw new DomainError(401, "oidc-code-exchange-failed", "Sign in could not be completed");
    const tokens = await response.json() as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new DomainError(401, "oidc-id-token-missing", "Sign in response was incomplete");
    const jwks = await this.jwks(discovery.jwks_uri);
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      algorithms: ["RS256", "PS256", "ES256"],
      clockTolerance: 5,
    });
    const nonce = verified.payload["nonce"];
    if (typeof nonce !== "string" || !constantTimeEqual(hash(nonce), input.expectedNonceHash)) {
      throw new DomainError(401, "oidc-nonce-invalid", "Sign in response could not be verified");
    }
    const subject = verified.payload.sub;
    if (!subject) throw new DomainError(401, "oidc-subject-missing", "Sign in identity was incomplete");
    const displayName = [verified.payload["name"], verified.payload["preferred_username"], verified.payload["email"], subject]
      .find((value) => typeof value === "string" && value.trim()) as string;
    return { issuer: this.config.issuer, subject, displayName: displayName.trim().slice(0, 200) };
  }

  private async discovery(): Promise<DiscoveryDocument> {
    if (this.discoveryValue) return this.discoveryValue;
    const response = await this.fetcher(`${this.config.issuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new DomainError(503, "oidc-discovery-unavailable", "Sign in is temporarily unavailable");
    const value = await response.json() as Partial<DiscoveryDocument>;
    if (value.issuer !== this.config.issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) {
      throw new DomainError(503, "oidc-discovery-invalid", "Sign in provider configuration is invalid");
    }
    for (const endpoint of [value.authorization_endpoint, value.token_endpoint, value.jwks_uri]) new URL(endpoint);
    this.discoveryValue = value as DiscoveryDocument;
    return this.discoveryValue;
  }

  private async jwks(uri: string): Promise<JSONWebKeySet> {
    if (this.jwksValue) return this.jwksValue;
    const response = await this.fetcher(uri, { headers: { accept: "application/json" } });
    if (!response.ok) throw new DomainError(503, "oidc-keys-unavailable", "Sign in verification is temporarily unavailable");
    const value = await response.json() as Partial<JSONWebKeySet>;
    if (!Array.isArray(value.keys) || value.keys.length === 0) throw new DomainError(503, "oidc-keys-invalid", "Sign in verification keys are invalid");
    this.jwksValue = value as JSONWebKeySet;
    return this.jwksValue;
  }
}

export class DeterministicOidcProvider implements OidcProvider {
  constructor(private readonly issuer = "https://identity.test") {}
  async authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const url = new URL(`${this.issuer}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }
  async exchange(input: OidcExchangeInput): Promise<OidcIdentity> {
    if (!input.code.startsWith("code-")) throw new DomainError(401, "oidc-code-exchange-failed", "Sign in could not be completed");
    return { issuer: this.issuer, subject: input.code.slice(5), displayName: "Test customer" };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
