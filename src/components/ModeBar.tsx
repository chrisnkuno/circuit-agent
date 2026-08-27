import type { NovaMode } from "../lib/settings";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import type { RestoreScope } from "../lib/settings";

/**
 * The bar above the transcript: what Nova is allowed to do, and the handful of things you do *to* a
 * session rather than in it.
 *
 * Three kinds of control used to sit in one flat row, all looking alike — a choice of mode, some
 * one-shot actions, and a toggle about where the work runs. Two groups are left, ordered by how
 * consequential they are: the permission mode leads because it is the most consequential piece of
 * state in the window, and the inspect/undo actions follow.
 *
 * "Where the work runs" left this bar entirely and moved to the inspector, beside the sandbox's own
 * status. It is a property of the session rather than an action on it, it is touched perhaps once a
 * day, and holding it here cost the row enough width that the active mode's sentence — the thing
 * that actually teaches this control — had nowhere to sit.
 *
 * The modes are a `ToggleGroup` rather than four buttons wearing `role="radio"`: Radix gives the
 * group a single tab stop with arrow keys inside it, which is how a native segmented control
 * behaves, and refuses to leave the group with no value at all.
 *
 * The tooltips are not decoration. A four-way permission control whose meanings live nowhere is a
 * control most people will never be sure of — and the active mode's clause is printed beside the
 * segments as well, because a sentence you have to hover to find is not documentation.
 */

/**
 * `hint` is the sentence printed beside the control; `detail` is the longer one in its tooltip.
 * Two lengths rather than one, because the bar has room for a clause and a tooltip has room for a
 * sentence — and truncating the printed one with an ellipsis teaches nothing at all.
 */
const MODES: Array<{ id: NovaMode; label: string; hint: string; detail: string }> = [
  { id: "plan", label: "Plan", hint: "Reads and reasons; writes nothing", detail: "Read and reason only — no edits, no commands" },
  { id: "build", label: "Build", hint: "Every edit asks first", detail: "Every edit and command asks first" },
  { id: "auto", label: "Auto", hint: "Ordinary edits apply", detail: "Ordinary edits apply; sensitive actions still ask" },
  { id: "defender", label: "Defender", hint: "Security review; changes ask", detail: "Security review — find and fix real issues; every change still asks" },
];

export function ModeBar(props: {
  mode: NovaMode;
  busy: boolean;
  onMode: (mode: NovaMode) => void;
  onUndo: (scope?: RestoreScope) => void;
  onCancel: () => void;
  onShowDiff: () => void;
  onScan: () => void;
  onFiles: () => void;
}) {
  const active = MODES.find((mode) => mode.id === props.mode);
  return (
    <div className="mode-bar">
      <div className="mode-choice">
        <ToggleGroup
          type="single"
          value={props.mode}
          aria-label="Permission mode"
          disabled={props.busy}
          // Radix reports "" when an item is toggled off; a permission mode has no off, so an empty
          // value is discarded rather than pushed into state as a mode that does not exist.
          onValueChange={(next) => next && props.onMode(next as NovaMode)}
        >
          {MODES.map((mode) => (
            <Tooltip key={mode.id} label={mode.detail}>
              <ToggleGroupItem value={mode.id} aria-label={mode.label}>
                {mode.label}
              </ToggleGroupItem>
            </Tooltip>
          ))}
        </ToggleGroup>
        <p className="mode-hint">{active?.hint}</p>
      </div>

      <div className="mode-actions">
        <div className="btn-group" role="group" aria-label="Inspect the project">
          <Tooltip label="See what changed since the last checkpoint (Ctrl D)">
            <Button variant="ghost" onClick={props.onShowDiff}>Changes</Button>
          </Tooltip>
          <Tooltip label="Browse the project, read a file, mention one (Ctrl P)">
            <Button variant="ghost" onClick={props.onFiles}>Files</Button>
          </Tooltip>
          <Tooltip label="Scan the working tree for likely hardcoded secrets — no model turn needed">
            <Button variant="ghost" onClick={props.onScan}>Scan</Button>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="mode-rule" />

        <div className="btn-group" role="group" aria-label="This turn">
          <DropdownMenu>
            <Tooltip label="Revert the last turn — files and conversation by default (Ctrl Z)">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" disabled={props.busy}>Undo ▾</Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => props.onUndo("both")}>Undo files and conversation</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.onUndo("code")}>Undo files only</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => props.onUndo("conversation")}>Undo conversation only</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Red only while there is something to stop: a permanently red button in a toolbar stops
              meaning "careful" and starts meaning "decoration". */}
          <Tooltip label="Stop the turn in progress (Esc)">
            <Button variant={props.busy ? "danger" : "ghost"} disabled={!props.busy} onClick={props.onCancel}>
              Stop
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
