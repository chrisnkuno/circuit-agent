"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/lib/auth-client";
import { useCurrentOrganization } from "@/components/auth-panel";
import { TaskHistory } from "@/components/task-history";
import { formatRwf } from "@/lib/task-cost";
import type { TaskKind } from "@/lib/task-cost";
import {
  buildAboutLines,
  buildBanner,
  buildHelpLines,
  buildRunSessionLines,
  buildStatusLines,
  buildUnknownCommandLines,
  CELEBRATION_FRAMES,
  ORBIT_FRAMES,
  parseCommand,
  renderFailureBanner,
  renderStageTrack,
  renderStageTrackVertical,
  SPINNER_FRAMES,
  stageKeysFor,
  type Stage,
  type StageStatus,
  type TerminalLine,
} from "@/lib/terminal-simulation";

type LogTone = TerminalLine["tone"] | "input" | "banner";
type LogEntry = { id: string; tone: LogTone; text: string };
type TrackState = { stages: Stage[]; outcome?: "completed" | "failed" };

/**
 * One-click shortcuts for a real run — each just submits the identical "run coding
 * <objective>" command a person would type. Every coding run currently starts from an empty
 * E2B workspace (no GitHub App is registered yet, so no repository is ever actually cloned in
 * — see docs/gap-register.md), so presets that imply pre-existing code ("write a test" for
 * what?, "lint check" of what?) would be misleading. These two sets keep the presets honest:
 * the from-scratch set is genuinely self-contained; the existing-codebase set only appears
 * once an organization has a real connected repository to act on.
 */
const PRESETS_NO_REPOSITORY = [
  { label: "Add a README", objective: "add a README.md that explains what's in the workspace" },
  { label: "Create a utility + test", objective: "create a small pure utility function and a test that verifies it, then run the test" },
  { label: "Hello world script", objective: "create a small script that prints hello world and run it to verify" },
];

const PRESETS_WITH_REPOSITORY = [
  { label: "Add a missing test", objective: "find a function without test coverage, write a test for it, and verify it passes" },
  { label: "Lint check", objective: "run the project's lint or style check and report any issues" },
  { label: "Fix a failing check", objective: "find and fix a currently failing test or check in the repository" },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}

function toneForEvent(type: string): TerminalLine["tone"] {
  if (type.endsWith("_completed") || type === "task_completed") return "success";
  if (type.endsWith("_failed") || type === "approval_rejected") return "error";
  if (type === "payment_authorization_required" || type === "lease_expired" || type === "cancellation_requested") return "warn";
  if (type === "step_claimed") return "tool";
  if (type === "run_created") return "system";
  return "muted";
}

function initialStages(taskKind: TaskKind): Stage[] {
  return stageKeysFor(taskKind).map((key, index) => ({ key, label: key, status: index === 0 ? "active" : "pending" }));
}

/** Maps a real Convex agentSteps status onto the four visual stage states — never claims more progress than actually happened. */
function stageStatusFromStepStatus(status: string): StageStatus {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked" || status === "cancelled") return "failed";
  if (status === "running") return "active";
  return "pending";
}

export function TerminalConsole() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [orbitFrame, setOrbitFrame] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [celebrationFrame, setCelebrationFrame] = useState(0);
  const [track, setTrack] = useState<TrackState | null>(null);
  const [activeRunId, setActiveRunId] = useState<Id<"agentRuns"> | null>(null);
  const [resumeTaskId, setResumeTaskId] = useState<Id<"tasks"> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const runIdRef = useRef(0);
  const renderedEventIds = useRef<Set<string>>(new Set());

  const session = authClient.useSession();
  const organization = useCurrentOrganization();
  const startLiveRun = useAction(api.terminalRuns.startLiveCodingRun);
  const runDetail = useQuery(api.agentRuns.getRunDetail, activeRunId ? { runId: activeRunId } : "skip");
  const tasks = useQuery(api.tasks.listRecent, organization ? { organizationId: organization._id } : "skip");
  const githubInstallations = useQuery(api.githubModel.listForOrganization, organization ? { organizationId: organization._id } : "skip");
  const hasConnectedRepository = (githubInstallations ?? []).some((installation) => installation.status === "connected");
  const resumeRuns = useQuery(api.agentRuns.listForTask, resumeTaskId ? { taskId: resumeTaskId } : "skip");
  const presets = hasConnectedRepository ? PRESETS_WITH_REPOSITORY : PRESETS_NO_REPOSITORY;

  useEffect(() => {
    setLog([{ id: entryId(), tone: "banner", text: buildBanner() }]);
    const timer = setTimeout(() => appendLine({ tone: "muted", text: 'Type "help" to see available commands. "run coding <objective>" is a real, billed agent run once you sign in above.' }), 260);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [log]);

  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => {
      setOrbitFrame((frame) => (frame + 1) % ORBIT_FRAMES.length);
      setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length);
    }, 140);
    return () => clearInterval(interval);
  }, [busy]);

  // Plays a few celebration frames then settles, rather than animating forever.
  useEffect(() => {
    if (track?.outcome !== "completed") return;
    let cycles = 0;
    const interval = setInterval(() => {
      cycles += 1;
      setCelebrationFrame((frame) => (frame + 1) % CELEBRATION_FRAMES.length);
      if (cycles >= 5) clearInterval(interval);
    }, 260);
    return () => clearInterval(interval);
  }, [track?.outcome]);

  // Streams the real agentRunEvents ledger as it changes — this is Convex's own live
  // reactivity, not a timer: a new event appears here the moment the deployed dispatcher
  // or worker records it, whether that happens in one second or after the next cron tick.
  // The same data drives the stage-track art, so its progress is exactly the real progress.
  useEffect(() => {
    if (!runDetail) return;
    const newEvents = runDetail.events.filter((event) => !renderedEventIds.current.has(event._id));
    for (const event of newEvents) {
      renderedEventIds.current.add(event._id);
      appendLine({ tone: toneForEvent(event.type), text: `[${new Date(event.createdAt).toLocaleTimeString()}] ${event.message}` });
    }

    const stepByKey = new Map(runDetail.steps.map((step) => [step.stepKey, step]));
    const stages: Stage[] = stageKeysFor("coding").map((key) => {
      const step = stepByKey.get(key);
      return { key, label: key, status: step ? stageStatusFromStepStatus(step.status) : "pending" };
    });
    const runTerminal = ["completed", "failed", "cancelled"].includes(runDetail.run.status);
    setTrack({ stages, outcome: runTerminal ? (runDetail.run.status === "completed" ? "completed" : "failed") : undefined });

    if (newEvents.length === 0) return;
    if (runTerminal) {
      const task = tasks?.find((item) => item._id === runDetail.run.taskId);
      if (task) appendLine({ tone: runDetail.run.status === "completed" ? "success" : "error", text: `run ${runDetail.run.status} — spent ${formatRwf(Number(task.spentRwf))} of ${formatRwf(Number(task.maxRwf))} cap` });
      setBusy(false);
      setActiveRunId(null);
    } else if (runDetail.run.status === "awaiting_approval") {
      appendLine({ tone: "warn", text: "run is awaiting approval on a step this terminal does not drive — open the main workspace to decide it" });
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runDetail, tasks]);

  // Resuming a task from history: pick its latest run and hand it to the same live
  // reactivity path a fresh "run coding" already uses, so resumed status is exactly
  // as real as a run started in this session.
  useEffect(() => {
    if (!resumeTaskId || !resumeRuns) return;
    const latest = [...resumeRuns].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) {
      appendLine({ tone: "system", text: `resuming "${latest.objective}" — loading live status…` });
      // If this is already the run being tracked (e.g. resuming a task that's still
      // actively running), leave the track panel alone — clearing it here would blank
      // it with nothing to repaint it, since the runDetail-driven effect below only
      // fires again once activeRunId actually changes or a new event arrives.
      if (latest._id !== activeRunId) {
        renderedEventIds.current = new Set();
        setTrack(null);
        setBusy(true);
        setActiveRunId(latest._id);
      }
    } else {
      appendLine({ tone: "warn", text: "that task has no run yet." });
    }
    setResumeTaskId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeTaskId, resumeRuns]);

  function appendLine(line: { tone: LogTone; text: string }) {
    setLog((current) => [...current, { id: entryId(), ...line }]);
  }

  async function playScript(lines: TerminalLine[], trackTaskKind?: TaskKind) {
    const myRunId = ++runIdRef.current;
    setBusy(true);
    if (trackTaskKind) setTrack({ stages: initialStages(trackTaskKind) });
    const stageCount = trackTaskKind ? stageKeysFor(trackTaskKind).length : 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      await delay(line.delayMs);
      if (runIdRef.current !== myRunId) return;
      appendLine({ tone: line.tone, text: line.text });
      if (trackTaskKind) {
        const reachedIndex = Math.min(stageCount - 1, Math.floor(((index + 1) / lines.length) * stageCount));
        setTrack((current) => current && { stages: current.stages.map((stage, i) => ({ ...stage, status: i < reachedIndex ? "completed" : i === reachedIndex ? "active" : "pending" })) });
      }
    }
    if (runIdRef.current !== myRunId) return;
    setBusy(false);
    if (trackTaskKind) {
      // A settlement line (tone "success") only ever appears for a run that actually
      // finished; checking anywhere in the script (not just the last line) matters because
      // the script itself ends with a trailing "evidence recorded" note after settlement.
      const succeeded = lines.some((line) => line.tone === "success");
      if (succeeded) setTrack((current) => current && { stages: current.stages.map((stage) => ({ ...stage, status: "completed" })), outcome: "completed" });
      // Any other ending (e.g. an operations run paused at its approval gate) leaves the
      // track showing exactly how far it actually got — no fabricated completion.
    }
  }

  async function runLiveCoding(objective: string) {
    if (!session.data) {
      appendLine({ tone: "error", text: "sign in first (panel above) — a real run needs an authenticated workspace." });
      return;
    }
    if (!organization) {
      appendLine({ tone: "warn", text: "your workspace is still being set up — try again in a moment." });
      return;
    }
    runIdRef.current += 1;
    setBusy(true);
    setTrack({ stages: initialStages("coding") });
    appendLine({ tone: "system", text: `starting a real coding run — objective: "${objective}"` });
    appendLine({ tone: "muted", text: "creating task, authorizing budget, compiling the run graph, and nudging the dispatcher…" });
    try {
      const result = await startLiveRun({ organizationId: organization._id, objective, idempotencyKey: crypto.randomUUID() });
      renderedEventIds.current = new Set();
      setActiveRunId(result.runId);
    } catch (error) {
      appendLine({ tone: "error", text: errorMessage(error) });
      setTrack((current) => current && { ...current, outcome: "failed" });
      setBusy(false);
    }
  }

  function submit(raw: string) {
    appendLine({ tone: "input", text: raw || " " });
    if (raw.trim()) setHistory((current) => [...current, raw]);
    setHistoryIndex(null);

    const parsed = parseCommand(raw);
    if (parsed.kind === "empty") return;
    if (parsed.kind === "clear") { setLog([]); setTrack(null); return; }
    if (parsed.kind === "help") { void playScript(buildHelpLines()); return; }
    if (parsed.kind === "about") { void playScript(buildAboutLines()); return; }
    if (parsed.kind === "status") { void playScript(buildStatusLines()); return; }
    if (parsed.kind === "unknown") { void playScript(buildUnknownCommandLines(parsed.raw)); return; }
    if (parsed.kind === "run" && parsed.taskKind === "coding") { void runLiveCoding(parsed.objective); return; }
    appendLine({ tone: "warn", text: `only "run coding <objective>" is wired to a real agent right now — previewing ${parsed.taskKind} as a simulation instead.` });
    void playScript(buildRunSessionLines(parsed.taskKind, parsed.objective), parsed.taskKind);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim()) return;
    const value = input;
    setInput("");
    submit(value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex]);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) { setHistoryIndex(null); setInput(""); }
      else { setHistoryIndex(nextIndex); setInput(history[nextIndex]); }
    }
  }

  return (
    <div className="terminal-window" onClick={() => inputRef.current?.focus()}>
      <div className="terminal-titlebar">
        <span className="terminal-dot terminal-dot-red" />
        <span className="terminal-dot terminal-dot-yellow" />
        <span className="terminal-dot terminal-dot-green" />
        <span className="terminal-title">
          circuit-nova — {session.data ? session.data.user.email : "guest"} — agent session
          {busy && <span className="terminal-orbit">{ORBIT_FRAMES[orbitFrame]}</span>}
        </span>
      </div>
      {track && (
        <div className={`terminal-track-panel${track.outcome ? ` terminal-track-${track.outcome}` : ""}`}>
          <pre className="terminal-track-art terminal-track-art-wide">{renderStageTrack(track.stages, SPINNER_FRAMES[spinnerFrame])}</pre>
          <pre className="terminal-track-art terminal-track-art-narrow">{renderStageTrackVertical(track.stages, SPINNER_FRAMES[spinnerFrame])}</pre>
          {track.outcome === "completed" && <pre className="terminal-celebration">{CELEBRATION_FRAMES[celebrationFrame]}</pre>}
          {track.outcome === "failed" && <pre className="terminal-celebration terminal-failure-art">{renderFailureBanner()}</pre>}
        </div>
      )}
      <div className="terminal-body">
        {log.map((entry) => (
          <div key={entry.id} className={`terminal-line terminal-line-${entry.tone}`}>
            {entry.tone === "banner" ? (
              <pre className="terminal-banner">{entry.text}</pre>
            ) : entry.tone === "input" ? (
              <>
                <span className="terminal-prompt">$</span> {entry.text}
              </>
            ) : (
              entry.text
            )}
          </div>
        ))}
        <div className="terminal-presets">
          {presets.map((preset) => (
            <button key={preset.label} type="button" className="terminal-preset-button" disabled={busy} onClick={() => submit(`run coding ${preset.objective}`)}>
              {preset.label}
            </button>
          ))}
        </div>
        <form className="terminal-input-row" onSubmit={handleSubmit}>
          <span className="terminal-prompt">$</span>
          <input
            ref={inputRef}
            className="terminal-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={busy ? "agent is working — you can queue another command" : 'type a command, e.g. "run coding fix the flaky retry test"'}
            aria-label="Terminal command input"
          />
        </form>
        <div ref={logEndRef} />
      </div>
      <TaskHistory organizationId={organization?._id} onResumeTask={setResumeTaskId} />
    </div>
  );
}
