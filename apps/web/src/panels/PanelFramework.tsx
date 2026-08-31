import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Grip, LayoutPanelLeft, LockKeyhole, LockKeyholeOpen, RotateCcw, X } from "lucide-react";

import { Button, IconButton, Menu } from "../design-system";
import {
  defaultPanelLayout,
  fitPanel,
  PANEL_LAYOUT_KEY,
  persistPanelLayout,
  readPanelLayout,
  type PanelDock,
  type PanelLayout,
  type PanelPlacement,
  type ReservedPanelSlot,
} from "./panelLayout";

export interface PanelDefinition {
  id: string;
  title: string;
  slot: ReservedPanelSlot;
  children: ReactNode;
  canClose?: boolean;
  canCollapse?: boolean;
  canFloat?: boolean;
}

const POSITIONS: Array<{ id: PanelDock; label: string }> = [
  { id: "left", label: "Dock left" },
  { id: "right", label: "Dock right" },
  { id: "bottom", label: "Dock bottom" },
  { id: "floating", label: "Detach panel" },
];

function viewport() { return { width: window.innerWidth, height: window.innerHeight }; }

export function PanelFramework({ panels, center, mode = "harness" }: {
  panels: PanelDefinition[];
  center?: ReactNode;
  mode?: "harness" | "editor";
}) {
  const [layout, setLayout] = useState<PanelLayout>(() => readPanelLayout(localStorage, viewport()));
  const [active, setActive] = useState(panels[0]?.id ?? "");
  const launchers = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusAfterClose = useRef<string | null>(null);

  useEffect(() => persistPanelLayout(localStorage, layout), [layout]);
  useEffect(() => {
    if (!focusAfterClose.current) return;
    launchers.current[focusAfterClose.current]?.focus();
    focusAfterClose.current = null;
  }, [layout]);
  useEffect(() => {
    const resize = () => setLayout((current) => ({
      ...current,
      panels: Object.fromEntries(Object.entries(current.panels).map(([id, placement]) => [id, fitPanel(placement, viewport())])),
    }));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function update(id: string, change: Partial<PanelPlacement>) {
    setLayout((current) => ({
      ...current,
      panels: { ...current.panels, [id]: fitPanel({ ...current.panels[id], ...change }, viewport()) },
    }));
    setActive(id);
  }

  function close(id: string) {
    focusAfterClose.current = id;
    update(id, { closed: true });
  }

  function reset() {
    localStorage.removeItem(PANEL_LAYOUT_KEY);
    setLayout(defaultPanelLayout(viewport()));
    setActive(panels[0]?.id ?? "");
  }

  return <div className={`panel-framework panel-framework-${mode}`} role={mode === "harness" ? "main" : undefined} aria-label={mode === "editor" ? "Editor panels" : "Internal panel layout harness"}>
    {mode === "harness" && <header className="panel-harness-header"><div><p className="eyebrow">Internal harness</p><h1>Panel framework</h1><p>Geometry, docking and persistence validation only.</p></div><Button onClick={reset}><RotateCcw aria-hidden="true" />Reset layout</Button></header>}
    <div className="panel-launchers" role="group" aria-label="Closed panels">{panels.map((panel) => layout.panels[panel.id]?.closed && <button type="button" className="ds-button ds-button-secondary ds-button-normal" key={panel.id} ref={(node) => { launchers.current[panel.id] = node; }} onClick={() => update(panel.id, { closed: false })}>Open {panel.title}</button>)}</div>
    <div className="panel-focus-switcher" role="group" aria-label="Focused panel">{mode === "editor" && <button type="button" aria-pressed={active === "__canvas"} onClick={() => setActive("__canvas")}>Canvas</button>}{panels.map((panel) => !layout.panels[panel.id]?.closed && <button type="button" aria-pressed={active === panel.id} key={panel.id} onClick={() => setActive(panel.id)}>{panel.title}</button>)}</div>
    <div className="panel-workbench" data-active-panel={active}>{panels.map((panel) => {
      const placement = layout.panels[panel.id];
      if (!placement || placement.closed) return null;
      return <PanelWindow key={panel.id} definition={panel} placement={placement} active={active === panel.id} update={(change) => update(panel.id, change)} close={() => close(panel.id)} />;
    })}<div className="panel-workbench-center">{center ?? <><LayoutPanelLeft aria-hidden="true" /><strong>Reserved editor surface</strong><span>No editor or document model is active.</span></>}</div></div>
  </div>;
}

function PanelWindow({ definition, placement, active, update, close }: {
  definition: PanelDefinition;
  placement: PanelPlacement;
  active: boolean;
  update: (change: Partial<PanelPlacement>) => void;
  close: () => void;
}) {
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const resize = useRef<{ width: number; height: number; startX: number; startY: number } | null>(null);
  const style = placement.dock === "floating" ? { left: placement.x, top: placement.y, width: placement.width, height: placement.collapsed ? 52 : placement.height }
    : placement.dock === "bottom" ? { height: placement.collapsed ? 52 : placement.height }
      : { width: placement.width };

  function dragStart(event: ReactPointerEvent<HTMLElement>) {
    if (placement.dock !== "floating" || (event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: placement.x, y: placement.y, startX: event.clientX, startY: event.clientY };
  }

  function dragMove(event: ReactPointerEvent<HTMLElement>) {
    if (!drag.current) return;
    update({ x: drag.current.x + event.clientX - drag.current.startX, y: drag.current.y + event.clientY - drag.current.startY });
  }

  function keyboardMove(event: React.KeyboardEvent<HTMLElement>) {
    if (placement.dock !== "floating" || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const x = event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0;
    const y = event.key === "ArrowUp" ? -10 : event.key === "ArrowDown" ? 10 : 0;
    update(event.shiftKey ? { width: placement.width + x, height: placement.height + y } : { x: placement.x + x, y: placement.y + y });
  }

  function resizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { width: placement.width, height: placement.height, startX: event.clientX, startY: event.clientY };
  }

  function resizeMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!resize.current) return;
    update({ width: resize.current.width + event.clientX - resize.current.startX, height: resize.current.height + event.clientY - resize.current.startY });
  }

  return <article className={`panel-window dock-${placement.dock}${active ? " is-active" : ""}${placement.collapsed ? " is-collapsed" : ""}`} style={style} aria-label={definition.title} data-panel-id={definition.id} data-slot={definition.slot}>
    <header className="panel-window-header" tabIndex={0} onFocus={() => update({})} onKeyDown={keyboardMove} onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={() => { drag.current = null; }}>
      <Grip aria-hidden="true" /><strong>{definition.title}</strong>
      <div className="panel-window-actions">
        <Menu label="Panel position" items={POSITIONS.filter((item) => item.id !== "floating" || definition.canFloat !== false).map((item) => ({ ...item, selected: item.id === placement.dock }))} onSelect={(dock) => update({ dock: dock as PanelDock, collapsed: false })} />
        <IconButton label={placement.pinned ? "Unpin panel" : "Pin panel"} onClick={() => update({ pinned: !placement.pinned })}>{placement.pinned ? <LockKeyhole aria-hidden="true" /> : <LockKeyholeOpen aria-hidden="true" />}</IconButton>
        {definition.canCollapse !== false && <IconButton label={placement.collapsed ? "Expand panel" : "Collapse panel"} onClick={() => update({ collapsed: !placement.collapsed })}>{placement.collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}</IconButton>}
        {definition.canClose !== false && <IconButton label="Close panel" disabled={placement.pinned} onClick={close}><X aria-hidden="true" /></IconButton>}
      </div>
    </header>
    {!placement.collapsed && <div className="panel-window-content">{definition.children}</div>}
    {placement.dock === "floating" && !placement.collapsed && <button type="button" className="panel-resize" aria-label="Resize panel" onPointerDown={resizeStart} onPointerMove={resizeMove} onPointerUp={() => { resize.current = null; }} />}
  </article>;
}

export function InternalPanelHarness() {
  return <PanelFramework panels={[
    { id: "inspector", title: "Layout fixture", slot: "tool", children: <p>This internal surface validates panel geometry without exposing editor controls.</p> },
    { id: "conversation", title: "Secondary fixture", slot: "conversation", children: <p>This reserved slot validates independent docking and responsive focus.</p> },
  ]} />;
}
