import { Component, type ReactNode } from "react";
import { logDiag } from "../lib/diagnostics";

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
    logDiag({
      level: "error",
      source: "error-boundary",
      message: `${this.props.label ?? "react"}: ${err instanceof Error ? err.message : String(err)}`,
      detail: {
        stack: err instanceof Error ? err.stack : undefined,
        componentStack: info.componentStack ?? undefined,
      },
    });
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.err, this.reset);
    return (
      <div role="alert" className="error-boundary-card">
        <div className="error-boundary-title">
          {this.props.label ?? "Component"} crashed
        </div>
        <code className="error-boundary-msg">{this.state.err.message}</code>
        <div className="error-boundary-actions">
          <button onClick={this.reset}>Retry</button>
          <button onClick={() => window.location.reload()}>Reload window</button>
        </div>
      </div>
    );
  }
}
