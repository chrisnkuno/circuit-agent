"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/lib/auth-client";
import { useCurrentOrganization } from "@/components/auth-panel";
import { formatRwf } from "@/lib/task-cost";
import {
  buildAboutLines,
  buildBanner,
  buildHelpLines,
  buildRunSessionLines,
  buildStatusLines,
  buildUnknownCommandLines,
  parseCommand,
  ORBIT_FRAMES,
  type TerminalLine,
} from "@/lib/terminal-simulation";

type LogTone = TerminalLine["tone"] | "input" | "banner";
type LogEntry = { id: string; tone: LogTone; text: string };

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

export function TerminalConsole() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [orbitFrame, setOrbitFrame] = useState(0);
  const [activeRunId, setActiveRunId] = useState<Id<"agentRuns"> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const runIdRef = useRef(0);
  const renderedEventIds = useRef<Set<string>>(new Set());

  const session = authClient.useSession();
  const organization = useCurrentOrganization();
  const startLiveRun = useAction(api.terminalRuns.startLiveCodingRun);
  const runDetail = useQuery(api.agentRuns.getRunDetail, activeRunId ? { runId: activeRunId } : "skip");
  const tasks = useQuery(api.tasks.listRecent, organization ? { organizationId: organization._id } : "skip");

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
    const interval = setInterval(() => setOrbitFrame((frame) => (frame + 1) % ORBIT_FRAMES.length), 140);
    return () => clearInterval(interval);
  }, [busy]);

  // Streams the real agentRunEvents ledger as it changes — this is Convex's own live
  // reactivity, not a timer: a new event appears here the moment the deployed dispatcher
  // or worker records it, whether that happens in one second or after the next cron tick.
  useEffect(() => {
    if (!runDetail) return;
    const newEvents = runDetail.events.filter((event) => !renderedEventIds.current.has(event._id));
    if (newEvents.length === 0) return;
    for (const event of newEvents) {
      renderedEventIds.current.add(event._id);
      appendLine({ tone: toneForEvent(event.type), text: `[${new Date(event.createdAt).toLocaleTimeString()}] ${event.message}` });
    }
    const terminalStatus = ["completed", "failed", "cancelled"].includes(runDetail.run.status);
    if (terminalStatus) {
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

  function appendLine(line: { tone: LogTone; text: string }) {
    setLog((current) => [...current, { id: entryId(), ...line }]);
  }

  async function playScript(lines: TerminalLine[]) {
    const myRunId = ++runIdRef.current;
    setBusy(true);
    for (const line of lines) {
      await delay(line.delayMs);
      if (runIdRef.current !== myRunId) return;
      appendLine({ tone: line.tone, text: line.text });
    }
    if (runIdRef.current === myRunId) setBusy(false);
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
    appendLine({ tone: "system", text: `starting a real coding run — objective: "${objective}"` });
    appendLine({ tone: "muted", text: "creating task, authorizing budget, compiling the run graph, and nudging the dispatcher…" });
    try {
      const result = await startLiveRun({ organizationId: organization._id, objective, idempotencyKey: crypto.randomUUID() });
      renderedEventIds.current = new Set();
      setActiveRunId(result.runId);
    } catch (error) {
      appendLine({ tone: "error", text: errorMessage(error) });
      setBusy(false);
    }
  }

  function submit(raw: string) {
    appendLine({ tone: "input", text: raw || " " });
    if (raw.trim()) setHistory((current) => [...current, raw]);
    setHistoryIndex(null);

    const parsed = parseCommand(raw);
    if (parsed.kind === "empty") return;
    if (parsed.kind === "clear") { setLog([]); return; }
    if (parsed.kind === "help") { void playScript(buildHelpLines()); return; }
    if (parsed.kind === "about") { void playScript(buildAboutLines()); return; }
    if (parsed.kind === "status") { void playScript(buildStatusLines()); return; }
    if (parsed.kind === "unknown") { void playScript(buildUnknownCommandLines(parsed.raw)); return; }
    if (parsed.kind === "run" && parsed.taskKind === "coding") { void runLiveCoding(parsed.objective); return; }
    appendLine({ tone: "warn", text: `only "run coding <objective>" is wired to a real agent right now — previewing ${parsed.taskKind} as a simulation instead.` });
    void playScript(buildRunSessionLines(parsed.taskKind, parsed.objective));
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
    </div>
  );
}
