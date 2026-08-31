export type CoordinationEventType = "upload.changed" | "session.logout" | "guest.handoff";

export interface CoordinationEvent {
  eventId: string;
  type: CoordinationEventType;
  occurredAt: string;
  ownerScope?: string;
  uploadSessionId?: string;
  workspaceId?: string;
}

interface UploadLease {
  tabId: string;
  expiresAt: number;
}

const EVENT_KEY = "ipw-coordination-event";
const LEASE_PREFIX = "ipw-upload-lease-";
const EVENT_TYPES = new Set<CoordinationEventType>(["upload.changed", "session.logout", "guest.handoff"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function parseCoordinationEvent(value: unknown): CoordinationEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CoordinationEvent>;
  if (!candidate.type || !EVENT_TYPES.has(candidate.type)
    || typeof candidate.eventId !== "string" || !SAFE_ID.test(candidate.eventId)
    || typeof candidate.occurredAt !== "string" || !Number.isFinite(Date.parse(candidate.occurredAt))) return null;
  for (const field of [candidate.ownerScope, candidate.uploadSessionId, candidate.workspaceId]) {
    if (field !== undefined && (typeof field !== "string" || !SAFE_ID.test(field))) return null;
  }
  return {
    eventId: candidate.eventId,
    type: candidate.type,
    occurredAt: candidate.occurredAt,
    ...(candidate.ownerScope ? { ownerScope: candidate.ownerScope } : {}),
    ...(candidate.uploadSessionId ? { uploadSessionId: candidate.uploadSessionId } : {}),
    ...(candidate.workspaceId ? { workspaceId: candidate.workspaceId } : {}),
  };
}

function parseLease(value: string | null): UploadLease | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<UploadLease>;
    return typeof candidate.tabId === "string" && SAFE_ID.test(candidate.tabId)
      && typeof candidate.expiresAt === "number" && Number.isSafeInteger(candidate.expiresAt)
      ? candidate as UploadLease
      : null;
  } catch {
    return null;
  }
}

class BrowserCoordinator {
  private readonly tabId = `tab-${crypto.randomUUID()}`;
  private readonly listeners = new Set<(event: CoordinationEvent) => void>();
  private readonly channel = "BroadcastChannel" in window ? new BroadcastChannel("ipw-browser-coordination-v1") : null;

  constructor() {
    this.channel?.addEventListener("message", (event) => this.receive(event.data));
    window.addEventListener("storage", (event) => {
      if (event.key === EVENT_KEY && event.newValue) {
        try { this.receive(JSON.parse(event.newValue)); } catch { /* Ignore malformed cross-tab state. */ }
      }
    });
  }

  subscribe(listener: (event: CoordinationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(input: Omit<CoordinationEvent, "eventId" | "occurredAt">): void {
    const event = parseCoordinationEvent({
      ...input,
      eventId: `event-${crypto.randomUUID()}`,
      occurredAt: new Date().toISOString(),
    });
    if (!event) throw new Error("Unsafe cross-tab coordination event");
    this.channel?.postMessage(event);
    localStorage.setItem(EVENT_KEY, JSON.stringify(event));
  }

  async withUploadLeadership<T>(uploadSessionId: string, operation: () => Promise<T>): Promise<T | null> {
    const name = `${LEASE_PREFIX}${uploadSessionId}`;
    if (navigator.locks) {
      return navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => lock ? operation() : null);
    }

    const key = name;
    const now = Date.now();
    const current = parseLease(localStorage.getItem(key));
    if (current && current.tabId !== this.tabId && current.expiresAt > now) return null;
    const lease: UploadLease = { tabId: this.tabId, expiresAt: now + 15_000 };
    localStorage.setItem(key, JSON.stringify(lease));
    if (parseLease(localStorage.getItem(key))?.tabId !== this.tabId) return null;
    const heartbeat = window.setInterval(() => {
      const held = parseLease(localStorage.getItem(key));
      if (held?.tabId === this.tabId) {
        localStorage.setItem(key, JSON.stringify({ tabId: this.tabId, expiresAt: Date.now() + 15_000 } satisfies UploadLease));
      }
    }, 5_000);
    try {
      return await operation();
    } finally {
      window.clearInterval(heartbeat);
      if (parseLease(localStorage.getItem(key))?.tabId === this.tabId) localStorage.removeItem(key);
    }
  }

  private receive(value: unknown): void {
    const event = parseCoordinationEvent(value);
    if (event) for (const listener of this.listeners) listener(event);
  }
}

export const browserCoordinator = typeof window === "undefined" ? null : new BrowserCoordinator();
