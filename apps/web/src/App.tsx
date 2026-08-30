import { Component, type ErrorInfo, type ReactNode } from "react";

import { createApiClient } from "./boundaries/apiClient";
import { recoveryOneFlags } from "./boundaries/featureFlags";
import { guestSession } from "./boundaries/session";
import { initialTrace } from "./boundaries/trace";
import { EmptyState, RecoverableError, ShellSection } from "./components/primitives";
import { majorOutcomes, routeFor, routes } from "./routes";

class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null };

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("recoverable-shell-error", { message: error.message, componentStack: info.componentStack });
  }

  render() {
    if (this.state.message) {
      return <RecoverableError message={this.state.message} />;
    }
    return this.props.children;
  }
}

function Home() {
  return (
    <ShellSection title="Home">
      <div className="outcome-grid">
        {majorOutcomes.map((outcome) => (
          <a className="outcome" href={outcome.path} key={outcome.path}>
            {outcome.label}
          </a>
        ))}
      </div>
    </ShellSection>
  );
}

function PlaceholderRoute({ title }: { title: string }) {
  return (
    <ShellSection title={title}>
      <EmptyState title="Foundation shell only" />
    </ShellSection>
  );
}

export function App() {
  const trace = initialTrace();
  const api = createApiClient(trace);
  const current = routeFor(window.location.pathname);

  return (
    <ErrorBoundary>
      <div className="app-shell" data-session={guestSession.status} data-trace={api.trace.trace_id}>
        <header className="topbar">
          <a className="brand" href="/">Visual Production Workspace</a>
          <nav aria-label="Primary">
            {routes.map((route) => (
              <a aria-current={route.path === current.path ? "page" : undefined} href={route.path} key={route.path}>
                {route.label}
              </a>
            ))}
          </nav>
        </header>
        <main>
          {current.path === "/" ? <Home /> : <PlaceholderRoute title={current.label} />}
        </main>
        <footer>
          <span>Free during testing</span>
          <span>{recoveryOneFlags.enabled("web-shell") ? "Shell active" : "Shell disabled"}</span>
        </footer>
      </div>
    </ErrorBoundary>
  );
}
