import { timingSafeEqual } from "node:crypto";

type Headers = Record<string, string | string[] | undefined>;

export const SESSION_COOKIE = process.env["NODE_ENV"] === "production" ? "__Host-ipw-session" : "ipw-session";
export const GUEST_COOKIE = process.env["NODE_ENV"] === "production" ? "__Host-ipw-guest" : "ipw-guest";
export const CSRF_COOKIE = process.env["NODE_ENV"] === "production" ? "__Host-ipw-csrf" : "ipw-csrf";

export function cookieValue(headers: Headers, name: string): string | null {
  const raw = headers["cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function secureCookie(name: string, value: string, maxAgeSeconds: number, httpOnly = true): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  const visibility = httpOnly ? "; HttpOnly" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}${visibility}`;
}

export function expiredCookie(name: string, httpOnly = true): string {
  return secureCookie(name, "", 0, httpOnly);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
