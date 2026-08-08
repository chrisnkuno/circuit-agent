"use client";

import { useEffect, useRef, useState } from "react";
import { Columns2, Maximize2, PanelRightClose, PanelRightOpen, Rows3 } from "lucide-react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { TerminalConsole, type TerminalConsoleHandle } from "@/components/terminal-console";
import { TaskHistory } from "@/components/task-history";
import { SchedulePanel } from "@/components/schedule-panel";
import { SandboxPanel } from "@/components/sandbox-panel";
import { PanelBoundary } from "@/components/panel-boundary";
import { ArtifactDrawer } from "@/components/artifact-drawer";
import { useCurrentOrganization } from "@/components/auth-panel";
import type { Id } from "@/convex/_generated/dataModel";

type LayoutMode = "split" | "focus" | "stacked";
const LAYOUT_STORAGE_KEY = "circuit-nova-terminal-layout";
/* Keep a real split on tablets in landscape; stack only when columns would starve. */
const NARROW_QUERY = "(max-width: 900px)";

const LAYOUT_MODES: { mode: LayoutMode; label: string; Icon: typeof Columns2 }[] = [
  { mode: "split", label: "Split columns", Icon: Columns2 },
  { mode: "focus", label: "Focus console", Icon: Maximize2 },
  { mode: "stacked", label: "Stacked rows", Icon: Rows3 },
];

/** useDefaultLayout falls back to `localStorage`, which does not exist during SSR. */
const PANEL_LAYOUT_STORAGE: Pick<Storage, "getItem" | "setItem"> =
  typeof window === "undefined"
    ? { getItem: () => null, setItem: () => undefined }
    : window.localStorage;

/**
 * Console + aside as an IDE-style shell: drag to resize (persisted), named layout
 * presets for quick focus, and a collapsible rail so the console can own the viewport.
 */
export function TerminalWorkspace() {
  const organization = useCurrentOrganization();
  const terminalRef = useRef<TerminalConsoleHandle>(null);
  const [layout, setLayout] = useState<LayoutMode>("split");
  const [asideOpen, setAsideOpen] = useState(true);
  const [filesTaskId, setFilesTaskId] = useState<Id<"tasks"> | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "circuit-nova-workspace-v3",
    panelIds: ["console", "aside"],
    storage: PANEL_LAYOUT_STORAGE,
  });

  useEffect(() => {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === "stacked" || stored === "split" || stored === "focus") {
      setLayout(stored);
      setAsideOpen(stored !== "focus");
    }
    const mq = window.matchMedia(NARROW_QUERY);
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  function selectLayout(mode: LayoutMode) {
    setLayout(mode);
    setAsideOpen(mode !== "focus");
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, mode);
  }

  const showAside = organization !== undefined && asideOpen && layout !== "focus";
  // Stacked = panels under the console. Focus/hide still fill the viewport (split class).
  const stacked = isNarrow || layout === "stacked";
  const useResize = !stacked && showAside;
  const fillViewport = !stacked;

  const aside = organization && (
    <aside className="nova-aside">
      <div className="nova-aside-rail">
        <span className="nova-rail-label">Workspace</span>
        <div className="nova-layout-switcher" role="group" aria-label="Panel layout">
          {LAYOUT_MODES.map(({ mode, label, Icon }) => (
            <button
              key={mode}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={layout === mode}
              className={`nova-layout-option${layout === mode ? " nova-layout-option-active" : ""}`}
              onClick={() => selectLayout(mode)}
            >
              <Icon size={14} strokeWidth={1.75} />
            </button>
          ))}
          {!isNarrow && showAside && (
            <button
              type="button"
              title="Hide side panels"
              aria-label="Hide side panels"
              className="nova-layout-option"
              onClick={() => setAsideOpen(false)}
            >
              <PanelRightClose size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
      <div className="nova-aside-stack">
        <PanelBoundary label="Task history">
          <TaskHistory
            organizationId={organization._id}
            onResumeTask={(taskId: Id<"tasks">) => terminalRef.current?.resumeTask(taskId)}
            onOpenFiles={setFilesTaskId}
          />
        </PanelBoundary>
        <PanelBoundary label="Sandboxes">
          <SandboxPanel organizationId={organization._id} />
        </PanelBoundary>
        <PanelBoundary label="Schedule">
          <SchedulePanel />
        </PanelBoundary>
      </div>
    </aside>
  );

  const consolePane = (
    <div className="nova-console-frame">
      <TerminalConsole ref={terminalRef} onOpenFiles={setFilesTaskId} />
    </div>
  );

  return (
    <main className={`nova-layout ${fillViewport ? "nova-layout-split" : "nova-layout-stacked"}`}>
      {organization && !showAside && fillViewport && (
        <button
          type="button"
          className="nova-aside-reveal"
          aria-label="Show side panels"
          title="Show side panels"
          onClick={() => {
            setAsideOpen(true);
            if (layout === "focus") selectLayout("split");
          }}
        >
          <PanelRightOpen size={16} strokeWidth={1.75} />
        </button>
      )}

      {useResize ? (
        <Group
          id="circuit-nova-workspace-v3"
          className="nova-panel-group"
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <Panel id="console" className="nova-slot nova-slot-console" minSize="48%" defaultSize="68%">
            {consolePane}
          </Panel>
          <Separator className="nova-resize-handle" />
          <Panel id="aside" className="nova-slot nova-slot-aside" minSize="24%" maxSize="48%" defaultSize="32%" collapsible collapsedSize="0%">
            {aside}
          </Panel>
        </Group>
      ) : (
        <>
          <div className="nova-slot nova-slot-console">{consolePane}</div>
          {showAside && <div className="nova-slot nova-slot-aside">{aside}</div>}
        </>
      )}

      <ArtifactDrawer taskId={filesTaskId} onClose={() => setFilesTaskId(null)} />
    </main>
  );
}
