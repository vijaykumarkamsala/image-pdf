export const PANEL_LAYOUT_VERSION = 1;
export const PANEL_LAYOUT_KEY = `ipw-panel-layout:v${PANEL_LAYOUT_VERSION}`;

export function panelLayoutKey(profile: string): string {
  return `${PANEL_LAYOUT_KEY}:${encodeURIComponent(profile)}`;
}

export type PanelDock = "left" | "right" | "bottom" | "floating";
export type ReservedPanelSlot = "tool" | "conversation";

export interface PanelPlacement {
  dock: PanelDock;
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
  collapsed: boolean;
  closed: boolean;
}

export interface PanelLayout {
  version: typeof PANEL_LAYOUT_VERSION;
  panels: Record<string, PanelPlacement>;
}

export interface PanelViewport { width: number; height: number }

const DEFAULT_PANELS: Record<string, PanelPlacement> = {
  inspector: { dock: "left", x: 28, y: 64, width: 320, height: 440, pinned: false, collapsed: false, closed: false },
  conversation: { dock: "right", x: 520, y: 84, width: 340, height: 420, pinned: false, collapsed: false, closed: false },
};

const DOCKS = new Set<PanelDock>(["left", "right", "bottom", "floating"]);

export function fitPanel(placement: PanelPlacement, viewport: PanelViewport): PanelPlacement {
  const width = Math.min(Math.max(260, placement.width), Math.max(260, viewport.width));
  const height = Math.min(Math.max(180, placement.height), Math.max(180, viewport.height));
  return {
    ...placement,
    width,
    height,
    x: Math.min(Math.max(0, placement.x), Math.max(0, viewport.width - width)),
    y: Math.min(Math.max(0, placement.y), Math.max(0, viewport.height - 52)),
  };
}

export function defaultPanelLayout(viewport: PanelViewport): PanelLayout {
  return {
    version: PANEL_LAYOUT_VERSION,
    panels: Object.fromEntries(Object.entries(DEFAULT_PANELS).map(([id, placement]) => [id, fitPanel({ ...placement }, viewport)])),
  };
}

function validPlacement(value: unknown): value is PanelPlacement {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PanelPlacement>;
  return typeof candidate.dock === "string" && DOCKS.has(candidate.dock as PanelDock)
    && [candidate.x, candidate.y, candidate.width, candidate.height].every((item) => typeof item === "number" && Number.isFinite(item))
    && [candidate.pinned, candidate.collapsed, candidate.closed].every((item) => typeof item === "boolean");
}

export function parsePanelLayout(raw: string | null, viewport: PanelViewport): PanelLayout {
  if (!raw) return defaultPanelLayout(viewport);
  try {
    const candidate = JSON.parse(raw) as Partial<PanelLayout>;
    if (candidate.version !== PANEL_LAYOUT_VERSION || !candidate.panels || typeof candidate.panels !== "object") {
      return defaultPanelLayout(viewport);
    }
    const panels = Object.fromEntries(Object.entries(DEFAULT_PANELS).map(([id, fallback]) => {
      const stored = candidate.panels?.[id];
      return [id, fitPanel(validPlacement(stored) ? stored : { ...fallback }, viewport)];
    }));
    return { version: PANEL_LAYOUT_VERSION, panels };
  } catch {
    return defaultPanelLayout(viewport);
  }
}

export function persistPanelLayout(storage: Pick<Storage, "setItem">, layout: PanelLayout, key = PANEL_LAYOUT_KEY): void {
  storage.setItem(key, JSON.stringify(layout));
}

export function readPanelLayout(storage: Pick<Storage, "getItem" | "removeItem">, viewport: PanelViewport, key = PANEL_LAYOUT_KEY): PanelLayout {
  const raw = storage.getItem(key);
  if (!raw) return defaultPanelLayout(viewport);
  try {
    const candidate = JSON.parse(raw) as Partial<PanelLayout>;
    if (candidate.version === PANEL_LAYOUT_VERSION && candidate.panels && typeof candidate.panels === "object"
      && Object.keys(DEFAULT_PANELS).every((id) => validPlacement(candidate.panels?.[id]))) {
      return parsePanelLayout(raw, viewport);
    }
  } catch {
    // Corrupted local layout state is discarded below.
  }
  if (raw) {
    storage.removeItem(key);
  }
  return defaultPanelLayout(viewport);
}
