import type { NovaMode } from "../lib/settings";

const MODES: Array<{ id: NovaMode; label: string; hint: string }> = [
  { id: "plan", label: "Plan", hint: "Read only" },
  { id: "build", label: "Build", hint: "Approve edits" },
  { id: "auto", label: "Auto", hint: "Apply edits" },
];

export function ModeBar(props: {
  mode: NovaMode;
  busy: boolean;
  sandbox: boolean;
  onMode: (mode: NovaMode) => void;
  onUndo: () => void;
  onCancel: () => void;
  onToggleSandbox: () => void;
  onPull: () => void;
}) {
  return (
    <div className="mode-bar">
      {MODES.map((mode) => (
        <button
          key={mode.id}
          className={`mode-chip ${props.mode === mode.id ? "active" : ""}`}
          disabled={props.busy}
          title={mode.hint}
          onClick={() => props.onMode(mode.id)}
          type="button"
        >
          {mode.label}
        </button>
      ))}
      <button className="btn ghost" disabled={props.busy} onClick={props.onUndo} type="button">
        Undo
      </button>
      <button className="btn ghost" disabled={!props.busy} onClick={props.onCancel} type="button">
        Cancel
      </button>
      <button
        className={`mode-chip ${props.sandbox ? "active" : ""}`}
        disabled={props.busy}
        onClick={props.onToggleSandbox}
        type="button"
        title="Run in E2B sandbox"
      >
        Sandbox
      </button>
      {props.sandbox ? (
        <button className="btn ghost" disabled={props.busy} onClick={props.onPull} type="button">
          Pull
        </button>
      ) : null}
    </div>
  );
}
