export interface EditorTabScope {
  actorId: string;
  workspaceId: string;
  documentId: string;
}

interface EditorTabLease extends EditorTabScope {
  tabId: string;
  expiresAt: number;
}

interface EditorTabEvent extends EditorTabScope {
  type: "opened" | "released";
  tabId: string;
  occurredAt: string;
}

const CHANNEL_NAME = "ipw-editor-tabs-v1";
const KEY_PREFIX = "ipw-editor-tab-";
const EVENT_KEY = "ipw-editor-tab-event";
const LEASE_MS = 15_000;

export class EditorTabCoordinator {
  private readonly tabId = `tab-${crypto.randomUUID()}`;
  private readonly key: string;
  private readonly channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL_NAME) : null;
  private heartbeat: number | null = null;
  private releaseWebLock: (() => void) | null = null;
  private readonly releasedListeners = new Set<() => void>();

  constructor(private readonly scope: EditorTabScope, private readonly onLost: () => void) {
    this.key = `${KEY_PREFIX}${scope.actorId}:${scope.workspaceId}:${scope.documentId}`;
    this.channel?.addEventListener("message", (event) => this.receive(event.data));
    window.addEventListener("storage", this.onStorage);
  }

  async claim(): Promise<boolean> {
    if (navigator.locks) {
      const acquired = new Promise<boolean>((resolve) => {
        void navigator.locks.request(this.key, { mode: "exclusive", ifAvailable: true }, (lock) => {
          resolve(Boolean(lock));
          if (!lock) return undefined;
          return new Promise<void>((release) => { this.releaseWebLock = release; });
        });
      });
      if (!await acquired) return false;
      this.publish("opened");
      return true;
    }
    const now = Date.now();
    const existing = parseLease(localStorage.getItem(this.key));
    if (existing && existing.tabId !== this.tabId && existing.expiresAt > now) return false;
    this.writeLease(now + LEASE_MS);
    if (parseLease(localStorage.getItem(this.key))?.tabId !== this.tabId) return false;
    this.publish("opened");
    this.heartbeat = window.setInterval(() => {
      const current = parseLease(localStorage.getItem(this.key));
      if (current?.tabId !== this.tabId) {
        this.stopHeartbeat();
        this.onLost();
        return;
      }
      this.writeLease(Date.now() + LEASE_MS);
    }, 5_000);
    return true;
  }

  onPeerReleased(listener: () => void): () => void {
    this.releasedListeners.add(listener);
    return () => this.releasedListeners.delete(listener);
  }

  release(): void {
    this.releaseWebLock?.();
    this.releaseWebLock = null;
    this.stopHeartbeat();
    if (parseLease(localStorage.getItem(this.key))?.tabId === this.tabId) localStorage.removeItem(this.key);
    this.publish("released");
  }

  dispose(): void {
    this.release();
    this.channel?.close();
    window.removeEventListener("storage", this.onStorage);
    this.releasedListeners.clear();
  }

  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === EVENT_KEY && event.newValue) {
      try { this.receive(JSON.parse(event.newValue)); } catch { /* Ignore malformed peer events. */ }
    }
  };

  private receive(value: unknown): void {
    const event = parseEvent(value);
    if (!event || event.tabId === this.tabId || !sameScope(event, this.scope)) return;
    if (event.type === "released") for (const listener of this.releasedListeners) listener();
  }

  private publish(type: EditorTabEvent["type"]): void {
    const event: EditorTabEvent = { ...this.scope, type, tabId: this.tabId, occurredAt: new Date().toISOString() };
    this.channel?.postMessage(event);
    localStorage.setItem(EVENT_KEY, JSON.stringify(event));
  }

  private writeLease(expiresAt: number): void {
    localStorage.setItem(this.key, JSON.stringify({ ...this.scope, tabId: this.tabId, expiresAt } satisfies EditorTabLease));
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

function parseLease(value: string | null): EditorTabLease | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<EditorTabLease>;
    return typeof candidate.actorId === "string" && typeof candidate.workspaceId === "string"
      && typeof candidate.documentId === "string" && typeof candidate.tabId === "string"
      && typeof candidate.expiresAt === "number" && Number.isSafeInteger(candidate.expiresAt)
      ? candidate as EditorTabLease
      : null;
  } catch { return null; }
}

function parseEvent(value: unknown): EditorTabEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<EditorTabEvent>;
  return (candidate.type === "opened" || candidate.type === "released")
    && typeof candidate.actorId === "string" && typeof candidate.workspaceId === "string"
    && typeof candidate.documentId === "string" && typeof candidate.tabId === "string"
    && typeof candidate.occurredAt === "string" && Number.isFinite(Date.parse(candidate.occurredAt))
    ? candidate as EditorTabEvent
    : null;
}

function sameScope(left: EditorTabScope, right: EditorTabScope): boolean {
  return left.actorId === right.actorId && left.workspaceId === right.workspaceId && left.documentId === right.documentId;
}
