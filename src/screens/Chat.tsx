import { useEffect, useRef, useState } from "react";
import { ApprovalModal, type ApprovalState } from "../components/ApprovalModal";
import { CostPanel } from "../components/CostPanel";
import { ModeBar } from "../components/ModeBar";
import { SessionList, type SessionSummary } from "../components/SessionList";
import { Message } from "../components/Message";
import { ModelPicker } from "../components/ModelPicker";
import { DiffPanel } from "../components/DiffPanel";
import { ScanPanel } from "../components/ScanPanel";
import { FilePanel } from "../components/FilePanel";
import { sendsOnKey } from "../lib/composer";
import { shouldFollow } from "../lib/transcript";
import { SHORTCUTS, isTypingTarget, matchShortcut } from "../lib/shortcuts";
import {
  cancelTurn,
  ensureSidecar,
  getCost,
  getTodos,
  listSessions,
  openScratchSession,
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
  loadWorkspaceState,
  saveWorkspaceState,
} from "../lib/ipc";
import {
  appendUserMessage,
  applyChatEvents,
  initialChatState,
  type ChatState,
} from "../lib/chat-state";
import type { NovaMode, NovaSettings, PermissionDecision, ProviderId } from "../lib/settings";

export function ChatScreen(props: {
  settings: NovaSettings;
  onOpenSettings: () => void;
  /** Bumped whenever the sidecar delivers an event; the value itself carries no meaning. */
  eventTick: number;
  /** Atomically removes and returns everything queued. Safe to call twice — the second call is empty. */
  takeEvents: () => import("../lib/settings").IpcEvent[];
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [mode, setModeState] = useState<NovaMode>("build");
  const [sandbox, setSandbox] = useState(false);
  const [upload, setUpload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Projects opened before, most recent first, so past work is reachable without re-finding it. */
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | undefined>();
  const [todos, setTodos] = useState<Array<{ id: string; content: string; status: string }>>([]);
  const [pinned, setPinned] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [active, setActive] = useState<{ provider: ProviderId; model: string }>({ provider: props.settings.provider, model: props.settings.model });
  // Everything the sidecar's event stream decides now lives in one reducer-owned value, so the
  // transcript's behaviour is the pure, tested `applyChatEvents` rather than six setState closures
  // buried in an effect. The screen keeps what is genuinely its own: scrolling, focus, dialogs.
  const { messages, approval, costReport, displayTotal, budgetFraction, error } = chat;
  const setError = (message: string | null) => setChat((current) => ({ ...current, error: message }));
  const setApproval = (next: ApprovalState | null) => setChat((current) => ({ ...current, approval: next }));
  const addSystemMessage = (content: string) =>
    setChat((current) => ({ ...current, messages: [...current.messages, { id: `sys-${Date.now()}`, role: "system", content }] }));
  const setCost = (report: string, total?: string, fraction?: number) =>
    setChat((current) => ({ ...current, costReport: report, displayTotal: total, budgetFraction: fraction }));

  const transcriptRef = useRef<HTMLDivElement>(null);
  const openingRef = useRef(false);
  /** Whether new output should scroll into view. A ref, so streaming does not re-render on it. */
  const followRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Take first, then fold. Taking is what makes this safe to run twice: StrictMode's second
    // invocation on mount gets an empty array, so nothing is applied a second time.
    const pending = props.takeEvents();
    if (pending.length === 0) return;
    setChat((current) => applyChatEvents(current, pending));
  }, [props.eventTick, props.takeEvents]);

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
      if (approval || showDiff || showScan || showFiles) return;
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

  /**
   * Remembers where the window was working, so the next launch is not blank.
   *
   * Called after a project opens and after a mode change rather than on every render: these are the
   * two moments the answer actually changes, and writing on every keystroke would put a disk write
   * behind the composer.
   */
  async function rememberWorkspace(nextRoot: string | null, nextMode: NovaMode = mode) {
    const recents = nextRoot
      // Most recent first, no duplicates, and bounded — this is a shortcut list, not a history file.
      ? [nextRoot, ...recentRoots.filter((entry) => entry !== nextRoot)].slice(0, 8)
      : recentRoots;
    setRecentRoots(recents);
    await saveWorkspaceState({
      ...(nextRoot ? { lastRoot: nextRoot } : {}),
      mode: nextMode,
      sandbox,
      recentRoots: recents,
    }).catch(() => undefined);
  }

  /**
   * Restores the last project on launch, and lists its past sessions.
   *
   * The app used to start with nothing open and no session list, and did not fetch sessions until
   * a project was opened or a message sent — so every launch lost the thread of what you were
   * doing, and past conversations were reachable only by re-finding the folder by hand.
   *
   * The session list is refreshed even when reopening fails: the folder may be on a disconnected
   * drive, but the transcripts are Nova's own and are still worth showing.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadWorkspaceState().catch(() => null);
      if (cancelled || !stored) return;
      if (stored.recentRoots?.length) setRecentRoots(stored.recentRoots);
      if (stored.mode) setModeState(stored.mode);
      if (stored.sandbox !== undefined) setSandbox(stored.sandbox);
      if (!stored.lastRoot) return;
      setPathDraft(stored.lastRoot);
      await refreshSessions(stored.lastRoot).catch(() => undefined);
      if (!cancelled) await openProjectAt(stored.lastRoot, { silent: true, ...(stored.mode ? { mode: stored.mode } : {}) });
    })();
    return () => { cancelled = true; };
    // Once, on mount: this is a restore, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openProjectAt(folder: string, options: { silent?: boolean; mode?: NovaMode } = {}) {
    const trimmed = folder.trim();
    // The mode is passed rather than read from state when the caller has just set it: a state
    // setter does not change the value this closure already captured, so restoring "auto" on launch
    // and then opening the project here would open the session in the previous mode — the UI would
    // read auto while the agent asked for approval on every write.
    const openMode = options.mode ?? mode;
    if (!trimmed || openingRef.current) return;
    openingRef.current = true;
    setError(null);
    setBusy(true);
    try {
      await ensureSidecar();
      await setSettings(props.settings);
      const opened = await openSession(trimmed, openMode, sandbox, sandbox && upload);
      setRoot(trimmed);
      setPathDraft(trimmed);
      setSessionId(opened.sessionId);
      // The session reports what it actually resolved, which is not always what settings asked for
      // — a saved model can be absent, and the provider falls back. Trusting settings here made the
      // picker claim "gpt-5.6-luna · current" while the session ran on claude-sonnet-5.
      if (opened.provider && opened.model) setActive({ provider: opened.provider as ProviderId, model: opened.model });
      // A newly opened session starts from an empty transcript, not the previous project's.
      setChat({ ...initialChatState(), messages: [{ id: "sys", role: "system", content: `Opened ${opened.workspace} · ${opened.provider}/${opened.model}` }] });
      await refreshSessions(trimmed);
      await rememberWorkspace(trimmed, openMode);
    } catch (err) {
      // A restore failing is not the user's action failing: the folder may simply have moved since
      // last launch, and shouting about it on every launch would be worse than starting quietly.
      if (!options.silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      openingRef.current = false;
    }
  }

  /**
   * Opens a session with no project folder. Returns the root it landed in, or null if it failed.
   *
   * Deliberately not silent: the transcript says which directory it landed in, because a file
   * written during a scratch chat is a real file and "where did that go" is the question that
   * follows otherwise.
   */
  async function openScratchProject(): Promise<string | null> {
    if (openingRef.current) return null;
    openingRef.current = true;
    setError(null);
    try {
      await ensureSidecar();
      await setSettings(props.settings);
      const opened = await openScratchSession(mode);
      setRoot(opened.root);
      setPathDraft(opened.root);
      setSessionId(opened.sessionId);
      if (opened.provider && opened.model) setActive({ provider: opened.provider as ProviderId, model: opened.model });
      addSystemMessage(`No project open — using a scratch workspace at ${opened.root}. Open a folder any time to switch.`);
      return opened.root;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
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
      addSystemMessage(`Mode → ${next}`);
      void rememberWorkspace(root, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!draft.trim() || busy) return;
    // No project open is no longer a refusal. Asking a question is not the same act as working on a
    // repository — "how do I write this migration" needs no folder — and the app used to answer that
    // with an error telling the reader to go and open something first. A scratch session is opened
    // on demand instead, and says where it put itself so the directory is not a surprise later.
    // The opener returns the root rather than relying on `root` having updated: a state setter does
    // not change the value already captured by this closure, so reading `root` again below would
    // still be null on the very turn that created the scratch session.
    const activeRoot = root ?? await openScratchProject();
    if (!activeRoot) return;
    const objective = draft.trim();
    setDraft("");
    setBusy(true);
    setChat((current) => appendUserMessage(current, objective));
    try {
      const result = await sendTurn(objective);
      setSessionId(result.sessionId);
      const cost = await getCost();
      setCost(cost.report, cost.displayTotal, cost.budgetFraction);
      setWarning(cost.warning);
      const todoState = await getTodos();
      setTodos(todoState.todos);
      await refreshSessions(activeRoot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    try {
      await undoTurn();
      addSystemMessage("Undid last turn checkpoint.");
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
      addSystemMessage(`Model → ${provider}/${model}`);
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
      // Resuming replaces the transcript, same as opening: what is on screen belongs to the
      // session being left, not the one being joined.
      setChat({ ...initialChatState(), messages: [{ id: "resume", role: "system", content: `Resumed ${resumed.title || resumed.sessionId}` }] });
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
        <div className="side-stack">
          {/* Projects opened before. Past conversations live under a project root, so without a way
              back to the root there is no way back to the conversation — the session list alone
              could only ever show whatever happened to be open. */}
          {recentRoots.length > 0 ? (
            <section className="recent-projects" aria-label="Recent projects">
              <h2>Recent projects</h2>
              <ul>
                {recentRoots.map((entry) => (
                  <li key={entry}>
                    <button
                      type="button"
                      className={`recent-project${entry === root ? " current" : ""}`}
                      title={entry}
                      disabled={busy}
                      onClick={() => void openProjectAt(entry)}
                    >
                      {/* The folder name leads because that is what a person recognises; the full
                          path stays available as a tooltip for two projects with the same name. */}
                      <span className="recent-name">{entry.split("/").filter(Boolean).at(-1) ?? entry}</span>
                      <span className="recent-path">{entry}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <SessionList
            sessions={sessions}
            activeId={sessionId}
            onResume={handleResume}
            onRefresh={() => root && refreshSessions(root)}
          />
        </div>

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
            onFiles={() => setShowFiles(true)}
            onToggleSandbox={() => {
              setSandbox((v) => !v);
              setUpload(true);
            }}
            onPull={async () => {
              try {
                const result = await pullSandbox();
                addSystemMessage(`Pulled sandbox to ${result.dest}`);
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
              placeholder={root ? "Ask Nova to work in this project…" : "Ask Nova anything — open a project to work in one"}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (!sendsOnKey({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing })) return;
                e.preventDefault();
                void handleSend();
              }}
            />
            <div className="composer-side">
              <button className="btn primary" type="button" disabled={busy || !draft.trim()} onClick={handleSend}>
                {busy ? "Working…" : "Send"}
              </button>
              <kbd className="composer-hint">↵ send · ⇧↵ newline</kbd>
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
      <FilePanel
        open={showFiles}
        onClose={() => setShowFiles(false)}
        onPick={(path) => {
          // Appended as an `@path` mention — the syntax the agent already understands — with a
          // separating space only when the draft does not already end in one, so picking two files
          // in a row does not run them together.
          setDraft((current) => `${current}${current === "" || current.endsWith(" ") ? "" : " "}@${path} `);
          composerRef.current?.focus();
        }}
      />
      {approval ? <ApprovalModal approval={approval} onRespond={handleApproval} /> : null}
    </div>
  );
}
