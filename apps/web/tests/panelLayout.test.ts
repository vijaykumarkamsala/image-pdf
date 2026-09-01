import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultPanelLayout,
  fitPanel,
  PANEL_LAYOUT_KEY,
  PANEL_LAYOUT_VERSION,
  panelLayoutKey,
  parsePanelLayout,
  persistPanelLayout,
  readPanelLayout,
} from "../src/panels/panelLayout.ts";

const desktop = { width: 1440, height: 900 };

test("panel layout persistence is versioned and round trips", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const layout = defaultPanelLayout(desktop);
  layout.panels.inspector.dock = "floating";
  layout.panels.inspector.x = 240;
  persistPanelLayout(storage, layout);
  assert.equal(JSON.parse(values.get(PANEL_LAYOUT_KEY)!).version, PANEL_LAYOUT_VERSION);
  assert.deepEqual(readPanelLayout(storage, desktop), layout);
});

test("corrupt and obsolete panel layouts recover to reachable defaults", () => {
  let removed = false;
  const storage = {
    getItem: () => "{broken",
    removeItem: () => { removed = true; },
  };
  assert.deepEqual(readPanelLayout(storage, desktop), defaultPanelLayout(desktop));
  assert.equal(removed, true);
  assert.deepEqual(parsePanelLayout(JSON.stringify({ version: 0, panels: {} }), desktop), defaultPanelLayout(desktop));
});

test("floating geometry is clamped to the active viewport", () => {
  const fitted = fitPanel({ dock: "floating", x: 2000, y: -50, width: 900, height: 1200, pinned: false, collapsed: false, closed: false }, { width: 390, height: 844 });
  assert.equal(fitted.width, 390);
  assert.equal(fitted.height, 844);
  assert.equal(fitted.x, 0);
  assert.equal(fitted.y, 0);
});

test("production panel layouts are isolated by actor, workspace and editor profile", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const ownerKey = panelLayoutKey("actor-owner:workspace-a:image-graphic-studio");
  const peerKey = panelLayoutKey("actor-peer:workspace-a:image-graphic-studio");
  const owner = defaultPanelLayout(desktop);
  owner.panels.inspector.dock = "floating";
  persistPanelLayout(storage, owner, ownerKey);
  assert.equal(readPanelLayout(storage, desktop, ownerKey).panels.inspector.dock, "floating");
  assert.equal(readPanelLayout(storage, desktop, peerKey).panels.inspector.dock, "left");
  assert.notEqual(ownerKey, peerKey);
});
