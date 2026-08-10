import { useEffect, useRef, useState } from "react";
import { ApprovalModal, type ApprovalState } from "../components/ApprovalModal";
import { CostPanel } from "../components/CostPanel";
import { ModeBar } from "../components/ModeBar";
import { SessionList, type SessionSummary } from "../components/SessionList";
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
  setSettings,
  undoTurn,
} from "../lib/ipc";
import type { NovaMode, NovaSettings, PermissionDecision } from "../lib/settings";

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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const assistantBuffer = useRef("");
  const openingRef = useRef(false);

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

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages]);

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
            onUndo={async () => {
              try {
                await undoTurn();
                setMessages((prev) => [...prev, { id: `undo-${Date.now()}`, role: "system", content: "Undid last turn checkpoint." }]);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
            onCancel={() => cancelTurn()}
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

          <div className="transcript" ref={transcriptRef}>
            {!root ? (
              <div className="msg system">Open a project folder to start a Nova session.</div>
            ) : null}
            {messages.map((message) => (
              <div key={message.id} className={`msg ${message.role}`}>
                {message.content}
              </div>
            ))}
            {todos.length > 0 ? (
              <div className="msg system">
                Todos:
                {todos.map((todo) => (
                  <div key={todo.id} className="todo-item">
                    [{todo.status}] {todo.content}
                  </div>
                ))}
              </div>
            ) : null}
            {error ? <div className="error-banner">{error}</div> : null}
            {sandbox ? (
              <div className="msg system">
                Sandbox mode {upload ? "with project upload" : "without upload"}.{" "}
                <button className="btn ghost" type="button" onClick={() => setUpload((v) => !v)}>
                  Toggle upload
                </button>
              </div>
            ) : null}
          </div>

          <div className="composer">
            <textarea
              value={draft}
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
            <button className="btn primary" type="button" disabled={busy || !draft.trim()} onClick={handleSend}>
              Send
            </button>
          </div>
        </section>

        <CostPanel report={costReport} displayTotal={displayTotal} budgetFraction={budgetFraction} warning={warning} />
      </div>

      {approval ? <ApprovalModal approval={approval} onRespond={handleApproval} /> : null}
    </div>
  );
}
