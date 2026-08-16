import { Component, type ErrorInfo, type ReactNode } from "react";
import { crashReportText, describeCrash, type CrashReport } from "../lib/crash";

/**
 * The last line of defence: a render error caught and drawn, instead of a blank window.
 *
 * This matters more in a desktop app than on the web. A React error escaping to the top unmounts
 * the tree, so the window goes white and stays white — and unlike a browser tab there is no
 * reload button, no address bar, and no console for the person looking at it. Their only recourse
 * is to kill the process, which loses the session they were in the middle of.
 *
 * So: say what happened, offer the two things that actually help — try again without restarting,
 * or copy something worth pasting into a bug report — and keep the window alive either way.
 *
 * Deliberately thin. Everything that can itself be wrong lives in `lib/crash.ts` where it is
 * tested; this only catches and draws.
 */

type Props = { children: ReactNode; version?: string };
type State = { report: CrashReport | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { report: null };

  static getDerivedStateFromError(error: unknown): State {
    return { report: describeCrash(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Still worth writing out: a packaged build's stderr is captured by the launcher, and this is
    // the only copy that survives the user clicking "Try again".
    console.error("[nova] render error", error, info.componentStack);
  }

  private retry = (): void => this.setState({ report: null });

  private copy = (): void => {
    const { report } = this.state;
    if (!report) return;
    const text = crashReportText(report, {
      version: this.props.version ?? "unknown",
      platform: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    });
    void navigator.clipboard?.writeText(text);
  };

  override render(): ReactNode {
    const { report } = this.state;
    if (!report) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <h1 className="crash-title">Nova hit an unexpected error</h1>
        <p className="crash-summary">{report.summary}</p>
        <pre className="crash-detail">{report.detail}</pre>
        <div className="crash-actions">
          <button className="btn primary" type="button" onClick={this.retry}>Try again</button>
          <button className="btn" type="button" onClick={this.copy}>Copy details</button>
        </div>
        <p className="crash-note">
          Your session is saved. If this keeps happening, restarting Nova will pick it back up.
        </p>
      </div>
    );
  }
}
