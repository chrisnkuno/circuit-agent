"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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

export function TerminalConsole() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [orbitFrame, setOrbitFrame] = useState(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const runIdRef = useRef(0);

  useEffect(() => {
    setLog([{ id: entryId(), tone: "banner", text: buildBanner() }]);
    const timer = setTimeout(() => appendLine({ tone: "muted", text: 'Type "help" to see available commands, or try: run fix the flaky retry test' }), 260);
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
          guest@circuit-nova — agent session
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
            placeholder={busy ? "agent is working — you can queue another command" : 'type a command, e.g. "run fix the flaky retry test"'}
            aria-label="Terminal command input"
          />
        </form>
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
