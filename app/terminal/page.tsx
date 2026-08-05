import type { Metadata } from "next";
import Link from "next/link";
import "../../components/terminal.css";
import { Starfield } from "@/components/starfield";
import { TerminalConsole } from "@/components/terminal-console";

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
        <p className="terminal-page-lede">
          A simulated session showing how a Circuit-Nova agent run actually reads: a quote, loaded capabilities, planner turns, tool calls, and a
          settlement inside the approved cap. Type <code>help</code> to start.
        </p>
        <TerminalConsole />
        <p className="terminal-footnote">Simulation only — no task is created, no model or sandbox is called, and no RWF is spent.</p>
      </div>
    </div>
  );
}
