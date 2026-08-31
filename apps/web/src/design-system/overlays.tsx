import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import { IconButton } from "./components";

const focusable = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, onClose, children, variant = "dialog" }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  variant?: "dialog" | "drawer" | "sheet";
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const first = node?.querySelector<HTMLElement>(focusable);
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !node) return;
      const elements = Array.from(node.querySelectorAll<HTMLElement>(focusable));
      if (!elements.length) return;
      const firstElement = elements[0];
      const lastElement = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) { event.preventDefault(); lastElement.focus(); }
      if (!event.shiftKey && document.activeElement === lastElement) { event.preventDefault(); firstElement.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); returnFocus.current?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(<div className="ds-modal-layer"><button className="ds-modal-scrim" aria-label={`Close ${title}`} onClick={onClose} /><div ref={panel} className={`ds-modal ds-modal-${variant}`} role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="ds-modal-heading"><h2 id={titleId}>{title}</h2><IconButton label="Close" onClick={onClose}><X aria-hidden="true" /></IconButton></div>{children}</div></div>, document.body);
}

export function Dialog(props: Omit<Parameters<typeof Modal>[0], "variant">) { return <Modal {...props} variant="dialog" />; }
export function Drawer(props: Omit<Parameters<typeof Modal>[0], "variant">) { return <Modal {...props} variant="drawer" />; }

export function Popover({ label, trigger, children, align = "end" }: { label: string; trigger: ReactNode; children: ReactNode; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return <div className="ds-popover-root" ref={root}><button type="button" className="ds-popover-trigger" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>{trigger}</button>{open && <div className={`ds-popover ds-popover-${align}`} id={id}>{children}</div>}</div>;
}

export interface MenuItem { id: string; label: string; selected?: boolean; disabled?: boolean }

export function Menu({ label, items, onSelect }: { label: string; items: MenuItem[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="ds-menu"><button type="button" className="ds-button ds-button-secondary ds-button-normal" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{label}<ChevronDown aria-hidden="true" /></button>{open && <div role="menu">{items.map((item) => <button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onSelect(item.id); setOpen(false); }}>{item.selected && <Check aria-hidden="true" />}<span>{item.label}</span></button>)}</div>}</div>;
}

export interface ToastMessage { id: string; message: string; tone?: "neutral" | "success" | "error" }

export function ToastViewport({ messages, dismiss }: { messages: ToastMessage[]; dismiss: (id: string) => void }) {
  return <div className="ds-toasts" role="region" aria-label="Notifications" aria-live="polite">{messages.map((toast) => <div className={`ds-toast ds-toast-${toast.tone ?? "neutral"}`} key={toast.id}><span>{toast.message}</span><IconButton label="Dismiss" onClick={() => dismiss(toast.id)}><X aria-hidden="true" /></IconButton></div>)}</div>;
}
