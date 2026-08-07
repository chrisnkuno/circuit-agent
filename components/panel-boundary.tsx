"use client";

import { Component, type ReactNode } from "react";

type Props = { label: string; children: ReactNode };
type State = { message: string | null };

/**
 * Keeps one side panel's failure from taking the console down with it.
 *
 * Convex's `useQuery` throws when its query errors, and an uncaught throw unmounts the whole React
 * tree — so a supplementary panel could blank the terminal a person was in the middle of using.
 * That happened for real: a newly deployed panel queried a function the deployment had not
 * finished publishing yet, and the entire page went to an error screen over an aside.
 *
 * The console is the page; these panels are additions to it. A panel that cannot render says so in
 * its own space and leaves everything else working.
 */
export class PanelBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : "This panel could not load" };
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div className="panel-boundary" role="status">
        <span className="panel-boundary-title">{this.props.label} unavailable</span>
        {/* The reason, not a shrug: the same message is what a person would report to fix it. */}
        <span className="panel-boundary-reason">{this.state.message.slice(0, 200)}</span>
        <button type="button" className="panel-boundary-retry" onClick={() => this.setState({ message: null })}>
          Retry
        </button>
      </div>
    );
  }
}
