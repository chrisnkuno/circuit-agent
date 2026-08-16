import { useEffect, useRef, useState } from "react";
import { ApprovalModal, type ApprovalState } from "../components/ApprovalModal";
import { CostPanel } from "../components/CostPanel";
import { ModeBar } from "../components/ModeBar";
import { SessionList, type SessionSummary } from "../components/SessionList";
import { Message } from "../components/Message";
import { ModelPicker } from "../components/ModelPicker";
import { DiffPanel } from "../components/DiffPanel";
import { ScanPanel } from "../components/ScanPanel";
import { shouldFollow } from "../lib/transcript";
import { SHORTCUTS, isTypingTarget, matchShortcut } from "../lib/shortcuts";
import {
  cancelTurn,
  ensureSidecar,
  getCost,
  getTodos,
  listSessions,
  openSession,
  pickFolder,
  pullSandbox,
  respondApproval,
  resumeSession,
  sendTurn,
  setMode,
  setModel,
  setSettings,
  undoTurn,
} from "../lib/ipc";
import type { NovaMode, NovaSettings, PermissionDecision, ProviderId } from "../lib/settings";

type ChatMessage =
  | { id: string; role: "user" | "assistant" | "system" | "tool"; content: string };

export function ChatScreen(props: {
  settings: NovaSettings;
  onOpenSettings: () => void;
  events: import("../lib/settings").IpcEvent[];
  clearEvents: () => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [mode, setModeState] = useState<NovaMode>("build");
  const [sandbox, setSandbox] = useState(false);
  const [upload, setUpload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [costReport, setCostReport] = useState("No turns yet.");
  const [displayTotal, setDisplayTotal] = useState<string | undefined>();
  const [budgetFraction, setBudgetFraction] = useState<number | undefined>();
  const [warning, setWarning] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [todos, setTodos] = useState<Array<{ id: string; content: string; status: string }>>([]);
  const [pinned, setPinned] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [active, setActive] = useState<{ provider: ProviderId; model: string }>({ provider: props.settings.provider, model: props.settings.model });
  const transcriptRef = useRef<HTMLDivElement>(null);
  const assistantBuffer = useRef("");
  const openingRef = useRef(false);
  /** Whether new output should scroll into view. A ref, so streaming does not re-render on it. */
  const followRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    for (const event of props.events) {
      if (event.type === "assistant_delta") {
        assistantBuffer.current += event.text;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant" && last.id === "streaming") {
            next[next.length - 1] = { ...last, content: assistantBuffer.current };
            return next;
          }
          return [...next, { id: "streaming", role: "assistant", content: assistantBuffer.current }];
        });
      } else if (event.type === "tool_call") {
        setMessages((prev) => [
          ...prev,
          { id: event.toolCallId, role: "tool", content: `→ ${event.name}${event.summary ? `: ${event.summary}` : ""}` },
        ]);
      } else if (event.type === "tool_result") {
        setMessages((prev) => [
          ...prev,
          {
            id: `${event.toolCallId}-result`,
            role: "tool",
            content: `${event.ok ? "✓" : "✗"} ${event.name}${event.preview ? `\n${event.preview}` : ""}`,
          },
        ]);
      } else if (event.type === "approval_needed") {
        setApproval({
          requestId: event.requestId,
          toolName: event.toolName,
          summary: event.summary,
        });
      } else if (event.type === "cost") {
        setCostReport(event.report);
        setDisplayTotal(event.displayTotal);
        setBudgetFraction(event.budgetFraction);
      } else if (event.type === "error") {
        setError(event.message);
      } else if (event.type === "turn_status" && event.status !== "running") {
        if (assistantBuffer.current) {
          const finalText = assistantBuffer.current;
          assistantBuffer.current = "";
          setMessages((prev) => {
            const next = prev.filter((m) => m.id !== "streaming");
            return [...next, { id: `assistant-${Date.now()}`, role: "assistant", content: finalText || event.summary || event.status }];
          });
        } else if (event.summary) {
          setMessages((prev) => [...prev, { id: `status-${Date.now()}`, role: "system", content: event.summary! }]);
        }
      }
    }
    if (props.events.length) props.clearEvents();
  }, [props.events, props.clearEvents]);

  // Follow new output only when the reader is already at the bottom. Scrolling up is an explicit
  // act; yanking them back on the next token makes reading during a turn impossible.
  useEffect(() => {
    const view = transcriptRef.current;
    if (!view || !followRef.current) return;
    view.scrollTo({ top: view.scrollHeight });
  }, [messages]);

  function handleTranscriptScroll() {
    const view = transcriptRef.current;
    if (!view) return;
    const following = shouldFollow(view);
    followRef.current = following;
    setPinned(!following);
  }

  function jumpToLatest() {
    const view = transcriptRef.current;
    if (!view) return;
    view.scrollTo({ top: view.scrollHeight, behavior: "smooth" });
    followRef.current = true;
    setPinned(false);
  }

  /**
   * Window-level shortcuts.
   *
   * Attached to the window rather than to a container so they work wherever focus happens to be —
   * a panel, a button, nothing at all. `isTypingTarget` is read from the event, not tracked, since
   * focus moves for reasons this component never sees.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A modal owns the keyboard while it is open; the approval dialog in particular must not
      // have Escape mean two different things at once.
      if (approval || showDiff || showScan) return;
      const action = matchShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        typing: isTypingTarget(event.target),
      });
      if (!action) return;
      event.preventDefault();
      switch (action) {
        case "send": void handleSend(); break;
        case "stop": if (busy) void cancelTurn(); break;
        case "undo": void handleUndo(); break;
        case "diff": setShowDiff(true); break;
        case "settings": props.onOpenSettings(); break;
        case "models": setModelMenuOpen((open) => !open); break;
        case "plan": void handleMode("plan"); break;
        case "build": void handleMode("build"); break;
        case "auto": void handleMode("auto"); break;
        case "defender": void handleMode("defender"); break;
        case "focus-composer": composerRef.current?.focus(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function refreshSessions(projectRoot: string) {
    const listed = await listSessions(projectRoot);
    setSessions(listed);
  }

  async function openProjectAt(folder: string) {
    const trimmed = folder.trim();
    if (!trimmed || openingRef.current) return;
    openingRef.current = true;
    setError(null);
    setBusy(true);
    try {
      await ensureSidecar();
      await setSettings(props.settings);
      const opened = await openSession(trimmed, mode, sandbox, sandbox && upload);
      setRoot(trimmed);
      setPathDraft(trimmed);
      setSessionId(opened.sessionId);
      // The session reports what it actually resolved, which is not always what settings asked for
      // — a saved model can be absent, and the provider falls back. Trusting settings here made the
      // picker claim "gpt-5.6-luna · current" while the session ran on claude-sonnet-5.
      if (opened.provider && opened.model) setActive({ provider: opened.provider as ProviderId, model: opened.model });
      setMessages([{ id: "sys", role: "system", content: `Opened ${opened.workspace} · ${opened.provider}/${opened.model}` }]);
      await refreshSessions(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      openingRef.current = false;
    }
  }

  async function chooseProject() {
    setError(null);
    try {
      const folder = await pickFolder();
      if (!folder) return;
      await openProjectAt(folder);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleMode(next: NovaMode) {
    if (!root) {
      setModeState(next);
      return;
    }
    setBusy(true);
    try {
      await setMode(next);
      setModeState(next);
      setMessages((prev) => [...prev, { id: `mode-${Date.now()}`, role: "system", content: `Mode → ${next}` }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!draft.trim() || busy) return;
    if (!root) {
      setError("Open a project folder first (Browse… or paste a path and press Open).");
      return;
    }
    const objective = draft.trim();
    setDraft("");
    setBusy(true);
    setError(null);
    assistantBuffer.current = "";
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", content: objective }]);
    try {
      const result = await sendTurn(objective);
      setSessionId(result.sessionId);
      const cost = await getCost();
      setCostReport(cost.report);
      setDisplayTotal(cost.displayTotal);
      setBudgetFraction(cost.budgetFraction);
      setWarning(cost.warning);
      const todoState = await getTodos();
      setTodos(todoState.todos);
      await refreshSessions(root);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    try {
      await undoTurn();
      setMessages((prev) => [...prev, { id: `undo-${Date.now()}`, role: "system", content: "Undid last turn checkpoint." }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleModel(provider: ProviderId, model: string) {
    setBusy(true);
    setError(null);
    try {
      await setModel(model, provider);
      setActive({ provider, model });
      // Said in the transcript rather than only in the header: a model change alters what every
      // later answer costs and how it reasons, so it belongs in the record of the conversation.
      setMessages((prev) => [...prev, { id: `model-${Date.now()}`, role: "system", content: `Model → ${provider}/${model}` }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleApproval(decision: PermissionDecision) {
    if (!approval) return;
    const requestId = approval.requestId;
    setApproval(null);
    try {
      await respondApproval(requestId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleResume(id: string) {
    if (!root) return;
    setBusy(true);
    setError(null);
    try {
      const resumed = (await resumeSession(root, id, mode, sandbox, sandbox && upload)) as {
        sessionId: string;
        title?: string;
      };
      setSessionId(resumed.sessionId);
      setMessages([{ id: "resume", role: "system", content: `Resumed ${resumed.title || resumed.sessionId}` }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <strong>Nova</strong>
          <span>
            <span className={`status-dot ${busy ? "busy" : "live"}`} />{" "}
            {root ? root : "No project open"}
            {sessionId ? ` · ${sessionId}` : ""}
          </span>
        </div>
        <div className="topbar-actions">
          <input
            className="path-input"
            value={pathDraft}
            placeholder="/path/to/project"
            disabled={busy}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void openProjectAt(pathDraft);
              }
            }}
          />
          <button className="btn" type="button" onClick={() => void openProjectAt(pathDraft)} disabled={busy || !pathDraft.trim()}>
            Open
          </button>
          <button className="btn" type="button" onClick={() => void chooseProject()} disabled={busy}>
            Browse…
          </button>
          <ModelPicker provider={active.provider} model={active.model} busy={busy} onPick={handleModel} open={modelMenuOpen} onOpenChange={setModelMenuOpen} />
          <button className="btn ghost" type="button" onClick={props.onOpenSettings}>
            Settings
          </button>
        </div>
      </header>

      <div className="workspace">
        <SessionList
          sessions={sessions}
          activeId={sessionId}
          onResume={handleResume}
          onRefresh={() => root && refreshSessions(root)}
        />

        <section className="chat-main">
          <ModeBar
            mode={mode}
            busy={busy}
            sandbox={sandbox}
            onMode={handleMode}
            onUndo={handleUndo}
            onCancel={() => cancelTurn()}
            onShowDiff={() => setShowDiff(true)}
            onScan={() => setShowScan(true)}
            onToggleSandbox={() => {
              setSandbox((v) => !v);
              setUpload(true);
            }}
            onPull={async () => {
              try {
                const result = await pullSandbox();
                setMessages((prev) => [...prev, { id: `pull-${Date.now()}`, role: "system", content: `Pulled sandbox to ${result.dest}` }]);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />

          <div className="transcript-wrap">
            <div className="transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>
              {!root ? (
                <div className="empty-state">
                  <h2>No project open</h2>
                  <p>Nova works inside a folder on this machine. Choose one to start a session.</p>
                  <button className="btn primary" type="button" onClick={() => void chooseProject()} disabled={busy}>
                    Browse for a folder…
                  </button>
                </div>
              ) : null}
              {messages.map((message) => (
                <Message key={message.id} role={message.role} content={message.content} streaming={message.id === "streaming"} />
              ))}
              {error ? (
                <div className="notice danger" role="alert">
                  <strong>Something went wrong</strong>
                  <span>{error}</span>
                  <button className="btn ghost" type="button" onClick={() => setError(null)}>Dismiss</button>
                </div>
              ) : null}
            </div>

            {/* Announced to assistive tech without being shown twice: the transcript itself is not a
                live region, because re-announcing the whole thing on every streamed token is noise. */}
            <p className="sr-only" aria-live="polite">{busy ? "Nova is working." : "Ready."}</p>

            {pinned ? (
              <button className="btn jump-latest" type="button" onClick={jumpToLatest}>
                Jump to latest ↓
              </button>
            ) : null}
          </div>

          <div className="composer">
            <textarea
              ref={composerRef}
              value={draft}
              aria-label="Message to Nova"
              placeholder={root ? "Ask Nova to work in this project…" : "Type here — open a project to send"}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <div className="composer-side">
              <button className="btn primary" type="button" disabled={busy || !draft.trim()} onClick={handleSend}>
                {busy ? "Working…" : "Send"}
              </button>
              <kbd className="composer-hint">Ctrl ↵</kbd>
            </div>
          </div>
        </section>

        <aside className="side-panel">
          {/* Todos are the agent's own plan — the answer to "what is it doing?" — so they belong in
              a fixed place you can watch, not appended to the bottom of a scrolling log where they
              slide away as output arrives. */}
          <div className="panel">
            <div className="panel-header">Plan</div>
            <div className="panel-body">
              {todos.length === 0 ? (
                <p className="panel-empty">No plan yet. Nova writes one for work that takes several steps.</p>
              ) : (
                <ol className="todo-list">
                  {todos.map((todo) => (
                    <li key={todo.id} className={`todo ${todo.status}`}>
                      <span className="todo-mark" aria-hidden="true">
                        {todo.status === "done" ? "●" : todo.status === "in_progress" ? "◐" : "○"}
                      </span>
                      <span>{todo.content}</span>
                      <span className="sr-only">{todo.status}</span>
                    </li>
                  ))}
                </ol>
              )}
              {sandbox ? (
                <div className="sandbox-note">
                  <strong>Sandbox</strong>
                  <span>{upload ? "Project uploaded to a remote machine." : "Starting empty — nothing uploaded."}</span>
                  <button className="btn ghost" type="button" onClick={() => setUpload((v) => !v)}>
                    {upload ? "Start empty instead" : "Upload the project"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <CostPanel report={costReport} displayTotal={displayTotal} budgetFraction={budgetFraction} warning={warning} />

          {/* Shortcuts that exist but are undocumented are shortcuts nobody finds. Collapsed, so
              they teach without taking room from the panels people actually watch. */}
          <details className="keys-help">
            <summary>Keyboard</summary>
            <dl>
              {SHORTCUTS.map((binding) => (
                <div key={binding.action}>
                  <dt><kbd>{binding.keys}</kbd></dt>
                  <dd>{binding.label}</dd>
                </div>
              ))}
            </dl>
          </details>
        </aside>
      </div>

      <DiffPanel open={showDiff} onClose={() => setShowDiff(false)} />
      <ScanPanel open={showScan} onClose={() => setShowScan(false)} />
      {approval ? <ApprovalModal approval={approval} onRespond={handleApproval} /> : null}
    </div>
  );
}
