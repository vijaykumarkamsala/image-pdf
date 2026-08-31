import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";
import { MemoryAuthRepository } from "../src/domains/identity/auth.repository.js";
import { AuthService } from "../src/domains/identity/auth.service.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "../src/domains/identity/cookies.js";
import { IdentityBoundary } from "../src/domains/identity/identity.service.js";
import { DeterministicOidcProvider, DiscoveryOidcProvider, loadOidcConfig } from "../src/domains/identity/oidc.provider.js";
import { MemoryProductKernelRepository } from "../src/kernel/memory.repository.js";
import { DeterministicRuntimeValues } from "../src/kernel/runtime.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("OIDC discovery, PKCE exchange, JWKS signature, issuer, audience and nonce are verified", async () => {
  const issuer = "https://identity.example.test";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const nonce = "nonce-customer";
  const idToken = await new SignJWT({ nonce, name: "Verified Customer" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer).setAudience("client-123").setSubject("subject-456")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new DiscoveryOidcProvider({
    issuer, clientId: "client-123", clientSecret: "secret-456", redirectUri: "https://app.example.test/v1/auth/callback",
  }, async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
    if (url.endsWith("/token")) return Response.json({ id_token: idToken });
    if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });
    return new Response(null, { status: 404 });
  });
  const authorization = new URL(await provider.authorizationUrl({ state: "state-1", nonce, codeChallenge: "challenge-1" }));
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("nonce"), nonce);
  const identity = await provider.exchange({ code: "code-1", codeVerifier: "verifier-1", expectedNonceHash: hash(nonce) });
  assert.deepEqual(identity, { issuer, subject: "subject-456", displayName: "Verified Customer" });
  const tokenRequest = requests.find((item) => item.url.endsWith("/token"))!;
  assert.match(String(tokenRequest.init?.body), /code_verifier=verifier-1/);
  assert.match(new Headers(tokenRequest.init?.headers).get("authorization") ?? "", /^Basic /);
  await assert.rejects(
    provider.exchange({ code: "code-2", codeVerifier: "verifier-2", expectedNonceHash: hash("wrong") }),
    /could not be verified/,
  );
});

test("authorization state is one-time and application sessions rotate and revoke server-side", async () => {
  const authRepository = new MemoryAuthRepository();
  const product = new MemoryProductKernelRepository(new DeterministicRuntimeValues());
  const auth = new AuthService(authRepository, new DeterministicOidcProvider(), product);
  const authorization = new URL(await auth.login({ "x-trace-id": "trace-login" }, "/app", undefined));
  const state = authorization.searchParams.get("state")!;
  const callback = await auth.callback({ "x-trace-id": "trace-login" }, "code-customer-1", state);
  assert.equal(callback.redirectTo, "/app");
  assert.equal((await auth.current({ cookie: `${SESSION_COOKIE}=${callback.issued.sessionToken}` })).authenticated, true);
  await assert.rejects(auth.callback({ "x-trace-id": "trace-replay" }, "code-customer-1", state), /already used/);
  await auth.logout({ cookie: `${SESSION_COOKIE}=${callback.issued.sessionToken}`, "x-trace-id": "trace-logout" });
  assert.equal((await auth.current({ cookie: `${SESSION_COOKIE}=${callback.issued.sessionToken}` })).authenticated, false);
  assert.deepEqual(authRepository.audits.map((item) => [item.action, item.outcome]), [
    ["identity.login", "succeeded"], ["identity.login", "failed"], ["identity.logout", "succeeded"],
  ]);
});

test("an elapsed rotation deadline replaces and revokes the old opaque session", async () => {
  const authRepository = new MemoryAuthRepository();
  const auth = new AuthService(
    authRepository,
    new DeterministicOidcProvider(),
    new MemoryProductKernelRepository(new DeterministicRuntimeValues()),
  );
  const previousToken = "previous-opaque-session";
  await authRepository.createSession({
    sessionIdHash: hash(previousToken),
    principal: { actorId: "actor-rotation", displayName: "Rotation Customer" },
    createdAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2099-08-31T08:00:00.000Z",
    rotateAfter: "2026-08-31T00:30:00.000Z",
    lastSeenAt: "2026-08-31T00:00:00.000Z",
  });

  const rotated = await auth.current({ cookie: `${SESSION_COOKIE}=${previousToken}` });
  assert.equal(rotated.authenticated, true);
  assert.ok(rotated.authenticated && rotated.issued);
  assert.equal((await auth.current({ cookie: `${SESSION_COOKIE}=${previousToken}` })).authenticated, false);
  assert.equal((await auth.current({ cookie: `${SESSION_COOKIE}=${rotated.authenticated ? rotated.issued!.sessionToken : ""}` })).authenticated, true);
});

test("customer actor headers are rejected and production configuration fails closed", async () => {
  const boundary = new IdentityBoundary(new MemoryAuthRepository());
  await assert.rejects(boundary.resolve({ "x-ipw-actor-id": "actor-spoofed", "x-ipw-actor-name": "Spoofed" }), /Sign in is required/);
  assert.throws(() => loadOidcConfig({ NODE_ENV: "production" }), /OIDC configuration is required/);
  assert.throws(() => loadOidcConfig({ NODE_ENV: "production", IPW_OIDC_ISSUER: "http://issuer" }), /required together/);
});

test("developer identity is isolated behind server sessions and logout requires CSRF", async () => {
  process.env["NODE_ENV"] = "test";
  process.env["IPW_DEV_IDENTITY_ENABLED"] = "1";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProductErrorFilter());
  await app.listen(0, "127.0.0.1");
  const port = (app.getHttpServer() as { address(): { port: number } }).address().port;
  const base = `http://127.0.0.1:${port}/v1`;
  try {
    const created = await fetch(`${base}/auth/developer-session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor_id: "actor-browser", display_name: "Browser Customer" }),
    });
    assert.equal(created.status, 201);
    const setCookies = created.headers.getSetCookie();
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrf = setCookies.find((value) => value.startsWith(`${CSRF_COOKIE}=`))!.split(";", 1)[0].split("=")[1];
    const bootstrap = await fetch(`${base}/session/bootstrap`, {
      method: "POST", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": "browser-bootstrap", "x-trace-id": "trace-browser" },
    });
    assert.equal(bootstrap.status, 201);
    const spoof = await fetch(`${base}/session/bootstrap`, {
      method: "POST", headers: { "x-ipw-actor-id": "actor-spoofed", "idempotency-key": "spoof", "x-trace-id": "trace-spoof" },
    });
    assert.equal(spoof.status, 401);
    assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, "x-csrf-token": csrf } })).status, 201);
    const after = await fetch(`${base}/auth/session`, { headers: { cookie } });
    assert.deepEqual(await after.json(), { authenticated: false });
  } finally {
    await app.close();
    delete process.env["IPW_DEV_IDENTITY_ENABLED"];
  }
});
