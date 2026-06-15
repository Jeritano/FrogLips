import { Component, type ReactNode } from "react";
import { logDiag } from "../lib/diagnostics";
import { api } from "../lib/tauri-api";

/**
 * Catches render/effect errors so a crash in one subtree doesn't blank the
 * entire app. Without this, a thrown error inside a `lazy()` chunk's module
 * body — or any uncaught render exception — unmounts the whole React tree
 * and leaves the user with a black window.
 *
 * Recovery: shows an inline error card with a Reload button (uses Tauri's
 * webview reload via `window.location.reload()`). All errors are also
 * funnelled into the Diagnostics panel.
 */
interface Props {
  children: ReactNode;
  /** Optional friendly label for the error card. */
  label?: string;
  /** Optional fallback. If omitted, a default reload card is shown. */
  fallback?: (err: Error, reset: () => void) => ReactNode;
}

interface State {
  err: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: unknown): State {
    return { err: err instanceof Error ? err : new Error(String(err)) };
  }

  componentDidCatch(err: unknown, info: { componentStack?: string | null }) {
    const label = this.props.label ?? "react";
    const message = err instanceof Error ? err.message : String(err);
    logDiag({
      level: "error",
      source: "error-boundary",
      message: `${label}: ${message}`,
      detail: {
        stack: err instanceof Error ? err.stack : undefined,
        componentStack: info.componentStack ?? undefined,
      },
    });
    // logDiag only reaches the in-memory ring + localStorage. A React render
    // crash is exactly the kind of fault we want preserved on disk for a bug
    // report, so also flush a single line to the on-disk diagnostics log
    // (~/.local-llm-app/diag.log via append_diag_log). That log sits beside
    // crash.log in the same data dir and is bundled into the support archive
    // alongside it (commands::misc support-bundle), so a caught error survives
    // a process restart even though crash.log itself is panic-hook-only and
    // has no frontend-writable command. Best-effort: api.appendDiagLog is
    // absent in some test mocks and the write must never re-throw out of an
    // error boundary.
    try {
      const stack = err instanceof Error && err.stack ? ` :: ${err.stack}` : "";
      void api
        .appendDiagLog?.(`[error-boundary] ${label}: ${message}${stack}`)
        .catch(() => undefined);
    } catch {
      /* swallow — disk forward is observational only */
    }
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.fallback)
      return this.props.fallback(this.state.err, this.reset);
    return (
      <div role="alert" className="error-boundary-card">
        <div className="error-boundary-title">
          {this.props.label ?? "Component"} crashed
        </div>
        <code className="error-boundary-msg">{this.state.err.message}</code>
        <div className="error-boundary-actions">
          <button onClick={this.reset}>Retry</button>
          <button onClick={() => window.location.reload()}>
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
