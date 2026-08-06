"use client";

import { useEffect, useRef, useState } from "react";
import { TerminalConsole, type TerminalConsoleHandle } from "@/components/terminal-console";
import { TaskHistory } from "@/components/task-history";
import { SchedulePanel } from "@/components/schedule-panel";
import { useCurrentOrganization } from "@/components/auth-panel";
import type { Id } from "@/convex/_generated/dataModel";

type LayoutMode = "stacked" | "split" | "focus";
const LAYOUT_STORAGE_KEY = "circuit-nova-terminal-layout";
const LAYOUT_MODES: { mode: LayoutMode; label: string }[] = [
  { mode: "stacked", label: "Stacked" },
  { mode: "split", label: "Split" },
  { mode: "focus", label: "Focus" },
];

/**
 * Console, task history, and the schedule/Telegram panel as three independently
 * positioned grid slots instead of one fixed vertical stack. The arrangement is a small,
 * fixed set of named CSS Grid layouts (not free-form drag) and the choice persists in
 * localStorage — "sticky" across visits without needing any backend schema.
 */
export function TerminalWorkspace() {
  const organization = useCurrentOrganization();
  const terminalRef = useRef<TerminalConsoleHandle>(null);
  const [layout, setLayout] = useState<LayoutMode>("stacked");

  useEffect(() => {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === "stacked" || stored === "split" || stored === "focus") setLayout(stored);
  }, []);

  function selectLayout(mode: LayoutMode) {
    setLayout(mode);
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, mode);
  }

  return (
    <>
      <div className="terminal-layout-switcher" role="group" aria-label="Panel layout">
        {LAYOUT_MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={`terminal-layout-option${layout === option.mode ? " terminal-layout-option-active" : ""}`}
            onClick={() => selectLayout(option.mode)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className={`terminal-layout terminal-layout-${layout}`}>
        <div className="terminal-layout-slot terminal-layout-slot-console">
          <TerminalConsole ref={terminalRef} />
        </div>
        <div className="terminal-layout-slot terminal-layout-slot-history">
          <TaskHistory organizationId={organization?._id} onResumeTask={(taskId: Id<"tasks">) => terminalRef.current?.resumeTask(taskId)} />
        </div>
        <div className="terminal-layout-slot terminal-layout-slot-schedule">
          <SchedulePanel />
        </div>
      </div>
    </>
  );
}
