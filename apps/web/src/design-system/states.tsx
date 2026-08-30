import type { ReactNode } from "react";
import { AlertTriangle, CloudOff, Inbox, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "./components";

export function StatePanel({ kind, title, message, action }: {
  kind: "loading" | "empty" | "error" | "offline" | "recovery";
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  const Icon = kind === "loading" ? LoaderCircle : kind === "empty" ? Inbox : kind === "offline" ? CloudOff : kind === "recovery" ? RotateCcw : AlertTriangle;
  return <section className={`ds-state ds-state-${kind}`} aria-busy={kind === "loading" ? true : undefined} role={kind === "error" ? "alert" : "status"}><span className="ds-state-icon"><Icon aria-hidden="true" /></span><h2>{title}</h2><p>{message}</p>{action && <Button tone="primary" onClick={action.onClick}>{action.label}</Button>}</section>;
}

export function LoadingBlock({ children = "Loading" }: { children?: ReactNode }) {
  return <div className="ds-loading" role="status"><LoaderCircle aria-hidden="true" /><span>{children}</span></div>;
}
