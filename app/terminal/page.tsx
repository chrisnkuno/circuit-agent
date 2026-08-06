import type { Metadata } from "next";
import Link from "next/link";
import "../../components/terminal.css";
import { Starfield } from "@/components/starfield";
import { AuthPanel } from "@/components/auth-panel";
import { TerminalWorkspace } from "@/components/terminal-workspace";

export const metadata: Metadata = {
  title: "Circuit-Nova — Agent Terminal",
  description: "An interactive, simulated agent terminal for Circuit-Nova.",
};

export default function TerminalPage() {
  return (
    <div className="terminal-page">
      <Starfield />
      <div className="terminal-page-inner">
        <header className="terminal-page-header">
          <Link className="terminal-back-link" href="/">
            ← Back to workspace
          </Link>
          <span className="terminal-page-title">Agent Terminal</span>
        </header>
        <div className="terminal-auth-row">
          <AuthPanel />
        </div>
        <p className="terminal-page-lede">
          Sign in, then <code>run coding &lt;objective&gt;</code> starts a real agent run: a real Convex task and budget, a real model call, and a
          real E2B sandbox — not a script. Other task kinds still preview as a labeled simulation. Type <code>help</code> to start.
        </p>
        <p className="terminal-footnote">A real coding run spends a small real amount against your workspace's RWF cap. Everything else stays a clearly-labeled preview.</p>
        <TerminalWorkspace />
      </div>
    </div>
  );
}
