"use client";

import { useEffect, useRef, useState } from "react";
import { TerminalConsole, type TerminalConsoleHandle } from "@/components/terminal-console";
import { TaskHistory } from "@/components/task-history";
import { SchedulePanel } from "@/components/schedule-panel";
import { useCurrentOrganization } from "@/components/auth-panel";
import type { Id } from "@/convex/_generated/dataModel";

type LayoutMode = "split" | "focus" | "stacked";
const LAYOUT_STORAGE_KEY = "circuit-nova-terminal-layout";

/** Glyphs, not words — the arrangement is self-evident from the shape of the icon. */
const LAYOUT_MODES: { mode: LayoutMode; label: string; glyph: string }[] = [
  { mode: "split", label: "Split columns", glyph: "▮▯" },
  { mode: "focus", label: "Focus console", glyph: "▰▯" },
  { mode: "stacked", label: "Stacked rows", glyph: "▤" },
];

/**
 * Console, task history, and the schedule/channel panel as three independently positioned
 * grid slots. The arrangement is a small, fixed set of named CSS Grid layouts (not free-form
 * drag) and the choice persists in localStorage — "sticky" across visits with no backend schema.
 */
export function TerminalWorkspace() {
  const organization = useCurrentOrganization();
  const terminalRef = useRef<TerminalConsoleHandle>(null);
  const [layout, setLayout] = useState<LayoutMode>("split");

  useEffect(() => {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === "stacked" || stored === "split" || stored === "focus") setLayout(stored);
  }, []);

  function selectLayout(mode: LayoutMode) {
    setLayout(mode);
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, mode);
  }

  // Signed out (or still provisioning) both side panels render nothing, so the aside would be
  // a dead half-screen. Collapse to a single full-width console until there's real content.
  const showAside = organization !== undefined;

  return (
    <main className={`nova-layout nova-layout-${showAside ? layout : "stacked"}`}>
      <div className="nova-slot nova-slot-console">
        <TerminalConsole ref={terminalRef} />
      </div>
      {organization && (
        <aside className="nova-slot nova-slot-aside">
          <div className="nova-aside-rail">
            <span className="nova-rail-label">Layout</span>
            <div className="nova-layout-switcher" role="group" aria-label="Panel layout">
              {LAYOUT_MODES.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  title={option.label}
                  aria-label={option.label}
                  aria-pressed={layout === option.mode}
                  className={`nova-layout-option${layout === option.mode ? " nova-layout-option-active" : ""}`}
                  onClick={() => selectLayout(option.mode)}
                >
                  {option.glyph}
                </button>
              ))}
            </div>
          </div>
          <TaskHistory organizationId={organization._id} onResumeTask={(taskId: Id<"tasks">) => terminalRef.current?.resumeTask(taskId)} />
          <SchedulePanel />
        </aside>
      )}
    </main>
  );
}
