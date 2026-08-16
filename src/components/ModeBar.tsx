import type { NovaMode } from "../lib/settings";

/**
 * Three different kinds of control used to sit in one flat row, all looking alike: a choice of
 * mode, two one-shot actions, and an unrelated toggle. Grouping them is most of the readability
 * win — and the modes are a radio group, so saying that out loud is what lets a screen reader
 * announce "Build, 2 of 4" instead of four unrelated buttons.
 */

const MODES: Array<{ id: NovaMode; label: string; hint: string }> = [
  { id: "plan", label: "Plan", hint: "Read and reason only — no edits, no commands" },
  { id: "build", label: "Build", hint: "Every edit and command asks first" },
  { id: "auto", label: "Auto", hint: "Ordinary edits apply; sensitive actions still ask" },
  { id: "defender", label: "Defender", hint: "Security review — find and fix real issues; every change still asks" },
];

export function ModeBar(props: {
  mode: NovaMode;
  busy: boolean;
  sandbox: boolean;
  onMode: (mode: NovaMode) => void;
  onUndo: () => void;
  onCancel: () => void;
  onShowDiff: () => void;
  onToggleSandbox: () => void;
  onPull: () => void;
}) {
  const active = MODES.find((mode) => mode.id === props.mode);
  return (
    <div className="mode-bar">
      <div className="segmented" role="radiogroup" aria-label="Permission mode">
        {MODES.map((mode) => (
          <button
            key={mode.id}
            className={`segment ${props.mode === mode.id ? "active" : ""}`}
            role="radio"
            aria-checked={props.mode === mode.id}
            disabled={props.busy}
            title={mode.hint}
            onClick={() => props.onMode(mode.id)}
            type="button"
          >
            {mode.label}
          </button>
        ))}
      </div>

      {/* The posture in words. A three-way permission control whose meaning lives only in a tooltip
          is a control most people will never be sure of. */}
      <span className="mode-hint">{active?.hint}</span>

      <div className="mode-actions">
        <button className="btn ghost" onClick={props.onShowDiff} type="button" title="See what changed since the last checkpoint">
          Changes
        </button>
        <button className="btn ghost" disabled={props.busy} onClick={props.onUndo} type="button" title="Revert the last turn's file changes">
          Undo
        </button>
        <button className="btn ghost" disabled={!props.busy} onClick={props.onCancel} type="button" title="Stop the turn in progress">
          Stop
        </button>
        <button
          className={`btn ghost toggle ${props.sandbox ? "on" : ""}`}
          disabled={props.busy}
          onClick={props.onToggleSandbox}
          type="button"
          aria-pressed={props.sandbox}
          title="Run the work on a remote E2B machine instead of this one"
        >
          Sandbox
        </button>
        {props.sandbox ? (
          <button className="btn ghost" disabled={props.busy} onClick={props.onPull} type="button" title="Copy the sandbox's files back to this machine">
            Pull files
          </button>
        ) : null}
      </div>
    </div>
  );
}
