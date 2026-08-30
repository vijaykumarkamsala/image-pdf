import type { ReactNode } from "react";

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return <p className="status" role="status">{label}</p>;
}

export function EmptyState({ title }: { title: string }) {
  return <p className="empty">{title}</p>;
}

export function RecoverableError({ message }: { message: string }) {
  return <p className="error" role="alert">{message}</p>;
}

export function ShellSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="shell-section" aria-labelledby={title.toLowerCase().replaceAll(" ", "-")}>
      <h2 id={title.toLowerCase().replaceAll(" ", "-")}>{title}</h2>
      {children}
    </section>
  );
}
