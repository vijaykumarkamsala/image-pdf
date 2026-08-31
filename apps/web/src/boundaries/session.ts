export interface SessionBoundary {
  status: "loading" | "signed_out" | "signed_in";
  workspaceId?: string;
}

export const loadingSession: SessionBoundary = { status: "loading" };

export interface StoredGuestSession {
  guestSessionId: string;
  expiresAt: string;
}

const GUEST_SESSION_KEY = "ipw-guest-session";

export function loadGuestSession(now = Date.now()): StoredGuestSession | null {
  const value = sessionStorage.getItem(GUEST_SESSION_KEY);
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<StoredGuestSession>;
    if (
      typeof candidate.guestSessionId === "string"
      && typeof candidate.expiresAt === "string"
      && new Date(candidate.expiresAt).getTime() > now
    ) return candidate as StoredGuestSession;
  } catch {
    // Invalid or expired browser state is replaced by a server-issued session.
  }
  sessionStorage.removeItem(GUEST_SESSION_KEY);
  return null;
}

export function storeGuestSession(session: StoredGuestSession): void {
  sessionStorage.setItem(GUEST_SESSION_KEY, JSON.stringify(session));
}

export function clearGuestBrowserState(): void {
  for (const key of Object.keys(sessionStorage)) {
    if (key === GUEST_SESSION_KEY || key.startsWith("ipw-active-uploads-") || key.startsWith("ipw-handoff-key-")) {
      sessionStorage.removeItem(key);
    }
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("ipw-active-uploads-") || key.startsWith("ipw-upload-lease-")) localStorage.removeItem(key);
  }
}

export function clearPrivateBrowserState(): void {
  sessionStorage.clear();
  for (const key of Object.keys(localStorage)) {
    if (key !== "ipw-theme") localStorage.removeItem(key);
  }
}
