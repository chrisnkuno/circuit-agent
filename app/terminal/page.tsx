import type { Metadata } from "next";
import Link from "next/link";
import "../../components/terminal.css";
import { Starfield } from "@/components/starfield";
import { AuthPanel } from "@/components/auth-panel";
import { TerminalWorkspace } from "@/components/terminal-workspace";

export const metadata: Metadata = {
  title: "Circuit-Nova — Agent Terminal",
  description: "A real, task-priced agent terminal: real Convex tasks, real model calls, real sandboxes.",
};

export default function TerminalPage() {
  return (
    <div className="terminal-page">
      <Starfield />
      <div className="nova-shell">
        <header className="nova-topbar">
          <Link className="nova-brand" href="/">
            <span className="nova-brand-mark" aria-hidden="true">◈</span>
            <span className="nova-brand-name">CIRCUIT<span className="nova-brand-dot">·</span>NOVA</span>
            <span className="nova-brand-tag">agent terminal</span>
          </Link>
          <div className="nova-topbar-auth">
            <AuthPanel />
          </div>
        </header>
        <TerminalWorkspace />
      </div>
    </div>
  );
}
