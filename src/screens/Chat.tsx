import { useEffect, useRef, useState } from "react";
import { ApprovalModal, type ApprovalState } from "../components/ApprovalModal";
import { CostPanel } from "../components/CostPanel";
import { ModeBar } from "../components/ModeBar";
import { SessionList, type SessionSummary } from "../components/SessionList";
import { Message } from "../components/Message";
import { ModelPicker } from "../components/ModelPicker";
import { DiffPanel } from "../components/DiffPanel";
import { ScanPanel } from "../components/ScanPanel";
import { GuidePanel } from "../components/GuidePanel";
import { FilePanel } from "../components/FilePanel";
import { sendsOnKey } from "../lib/composer";
import { STARTERS, projectName, shouldShowStarters } from "../lib/starters";
import { shouldFollow } from "../lib/transcript";
import { SHORTCUTS, isTypingTarget, matchShortcut } from "../lib/shortcuts";
import {
  activateTab as activateSidecarTab,
  cancelTurn,
  closeTab as closeSidecarTab,
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
  initialChatState,
  type ChatState,
} from "../lib/chat-state";
import {
  activeTab,
  addTab,
  activateTab as activateLocalTab,
  adoptTabId,
  applyTabEvents,
  blankTab,
  describeWork,
  findTab,
  initialTabsState,
  neighbourTabId,
  removeTab,
  tabAtPosition,
  updateTab,
  type TabsState,
  type WindowTab,
} from "../lib/tabs";
import { TabStrip } from "../components/TabStrip";
import type { NovaMode, NovaSettings, PermissionDecision, ProviderId } from "../lib/settings";

/**
 * The id the first tab carries before any session exists.
 *
 * The window has to be usable before it has a session — you can type a question with no project
 * open, and a scratch session is created when you send it — so the tab exists locally first and
 * adopts the sidecar's id once there is one to adopt.
 */
const LOCAL_TAB_ID = "local";



export function ChatScreen(props: {
  settings: NovaSettings;
  onOpenSettings: () => void;
  /** Bumped whenever the sidecar delivers an event; the value itself carries no meaning. */
  eventTick: number;
  /** Atomically removes and returns everything queued. Safe to call twice — the second call is empty. */
  takeEvents: () => import("../lib/settings").IpcEvent[];
}) {
  /**
   * Every piece of work this window is doing, and which one is in front.
   *
   * This one value replaces the dozen `useState`s that used to describe *the* session — the root,
   * the mode, the transcript, the cost, the draft. None of them were ever window-level facts; they
   * were session-level facts that had nowhere else to live while the window could only hold one
   * session. Moving them into a tab is most of what "tabs" means here, and it is why the sidecar
   * had to grow tab addressing first: two transcripts are only worth having if two turns can
   * actually run at once.
   */
  const [tabsState, setTabsState] = useState<TabsState>(() => addTab(initialTabsState(), blankTab(LOCAL_TAB_ID)));
  const [pathDraft, setPathDraft] = useState("");
  const [upload, setUpload] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Projects opened before, most recent first, so past work is reachable without re-finding it. */
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  // The tab in front, and its fields under the names the rest of this screen already used. Reading
  // them out once here is what kept the render below unchanged: the screen draws "the session", and
  // which session that is became a question with an answer rather than an assumption.
  const current = activeTab(tabsState);
  const tabId = current?.tabId;
  const root = current?.root ?? null;
  const sessionId = current?.sessionId;
  const mode = current?.mode ?? "build";
  const sandbox = current?.sandbox ?? false;
  const draft = current?.draft ?? "";
  const todos = current?.todos ?? [];
  const warning = current?.warning;
  const chat = current?.chat ?? initialChatState();
  const active = {
    provider: (current?.provider ?? props.settings.provider) as ProviderId,
    model: current?.model ?? props.settings.model,
  };
  // Busy means "this tab cannot take another instruction": a turn running in it, or a request for it
  // in flight. Deliberately *this* tab's business — a turn in another tab must not grey out the
  // composer here, which was the whole complaint that tabs answer.
  const busy = (current?.busy ?? false) || current?.status === "running";
  const { messages, approval, costReport, displayTotal, budgetFraction, error } = chat;

  /** Patches the tab in front. Every old `setSomething` became one of these. */
  // Resolved through `findTab` rather than keyed straight into `updateTab`, for the same reason
  // `patchChat` is: the id a caller captured before an open can be the local one the tab has since
  // traded for the sidecar's, and a patch that matches nothing fails silently. `setBusy(false)` in
  // an open's `finally` is exactly that case, and losing it leaves the tab busy for good.
  const patchTab = (patch: Partial<Omit<WindowTab, "tabId">>, id: string | undefined = tabId) =>
    setTabsState((state) => {
      const target = id ? findTab(state, id) : undefined;
      return target ? updateTab(state, target.tabId, patch) : state;
    });
  const patchChat = (update: (chat: ChatState) => ChatState, id: string | undefined = tabId) =>
    setTabsState((state) => {
      const target = id ? findTab(state, id) : undefined;
      return target ? updateTab(state, target.tabId, { chat: update(target.chat) }) : state;
    });
  const setDraft = (next: string | ((current: string) => string)) =>
    patchTab({ draft: typeof next === "function" ? next(draft) : next });
  const setError = (message: string | null) => patchChat((chat) => ({ ...chat, error: message }));
  const setApproval = (next: ApprovalState | null, id?: string) =>
    setTabsState((state) => {
      const target = id ?? tabId;
      const tab = target ? findTab(state, target) : undefined;
      return tab ? updateTab(state, tab.tabId, { chat: { ...tab.chat, approval: next }, needsApproval: next !== null }) : state;
    });
  const addSystemMessage = (content: string, id?: string) =>
    patchChat((chat) => ({ ...chat, messages: [...chat.messages, { id: `sys-${Date.now()}`, role: "system", content }] }), id ?? tabId);
  const setBusy = (value: boolean, id?: string) => patchTab({ busy: value }, id ?? tabId);

  const transcriptRef = useRef<HTMLDivElement>(null);
  /**
   * Tabs with an open in flight, so a double-click cannot start two sessions in the same tab.
   *
   * A set rather than the single boolean this was: with one flag, opening a project in one tab
   * silently refused to open one in another, which is precisely the thing tabs exist to allow — and
   * it would have refused *silently*, since the guard returns rather than reporting.
   */
  const openingRef = useRef(new Set<string>());
  /** Whether new output should scroll into view. A ref, so streaming does not re-render on it. */
  const followRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Take first, then fold. Taking is what makes this safe to run twice: StrictMode's second
    // invocation on mount gets an empty array, so nothing is applied a second time.
    const pending = props.takeEvents();
    if (pending.length === 0) return;
    // Routed by the tab the sidecar stamped on each event, never by which tab is in front: with two
    // turns streaming at once, "the active tab" is the wrong answer about half the time, and being
    // wrong here appends one piece of work's answer to another's transcript with nothing to show it.
    setTabsState((state) => applyTabEvents(state, pending));
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
      if (approval || showDiff || showScan || showFiles || showGuide) return;
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
        case "files": setShowFiles(true); break;
        case "guide": setShowGuide((open) => !open); break;
        case "settings": props.onOpenSettings(); break;
        case "models": setModelMenuOpen((open) => !open); break;
        case "plan": void handleMode("plan"); break;
        case "build": void handleMode("build"); break;
        case "auto": void handleMode("auto"); break;
        case "defender": void handleMode("defender"); break;
        case "focus-composer": composerRef.current?.focus(); break;
        case "tab-new": handleNewTab(); break;
        case "tab-close": if (tabId) void handleCloseTab(tabId); break;
        case "tab-next": {
          const next = neighbourTabId(tabsState, 1);
          if (next) void handleSelectTab(next);
          break;
        }
        case "tab-previous": {
          const previous = neighbourTabId(tabsState, -1);
          if (previous) void handleSelectTab(previous);
          break;
        }
        default: {
          // Ctrl+1…9 arrive as one action per position rather than as nine cases.
          const position = /^tab-select-(\d)$/.exec(action)?.[1];
          if (position) {
            const chosen = tabAtPosition(tabsState, Number(position));
            if (chosen) void handleSelectTab(chosen);
          }
          break;
        }
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
      setTabsState((state) => (state.activeTabId
        ? updateTab(state, state.activeTabId, {
            ...(stored.mode ? { mode: stored.mode } : {}),
            ...(stored.sandbox === undefined ? {} : { sandbox: stored.sandbox }),
          })
        : state));
      if (!stored.lastRoot) return;
      setPathDraft(stored.lastRoot);
      await refreshSessions(stored.lastRoot).catch(() => undefined);
      if (!cancelled) await openProjectAt(stored.lastRoot, { silent: true, ...(stored.mode ? { mode: stored.mode } : {}) });
    })();
    return () => { cancelled = true; };
    // Once, on mount: this is a restore, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The id the sidecar knows this tab by, or nothing for a tab it has never seen.
   *
   * A blank tab carries a local id until a session opens in it; sending that id to the sidecar
   * would be naming a tab that does not exist there, so the open goes in unaddressed and the tab
   * adopts whatever id comes back.
   */
  function sidecarTabId(id: string | undefined): string | undefined {
    return id && !id.startsWith(LOCAL_TAB_ID) ? id : undefined;
  }

  async function openProjectAt(folder: string, options: { silent?: boolean; mode?: NovaMode; tabId?: string } = {}) {
    const trimmed = folder.trim();
    const target = options.tabId ?? tabId;
    if (!target) return;
    // The mode is passed rather than read from state when the caller has just set it: a state
    // setter does not change the value this closure already captured, so restoring "auto" on launch
    // and then opening the project here would open the session in the previous mode — the UI would
    // read auto while the agent asked for approval on every write.
    const openMode = options.mode ?? mode;
    if (!trimmed || openingRef.current.has(target)) return;
    openingRef.current.add(target);
    setError(null);
    setBusy(true, target);
    try {
      await ensureSidecar();
      await setSettings(props.settings);
      // Into *this* tab: the sidecar replaces the session inside it and keeps the tab. Passing no
      // tab id would open a tenth tab every time somebody opened a folder.
      const opened = await openSession(trimmed, openMode, sandbox, sandbox && upload, sidecarTabId(target));
      setPathDraft(trimmed);
      setTabsState((state) => {
        const adopted = adoptTabId(state, target, opened.tabId);
        return updateTab(adopted, opened.tabId, {
          root: trimmed,
          title: opened.title,
          sessionId: opened.sessionId,
          mode: openMode,
          // The session reports what it actually resolved, which is not always what settings asked
          // for — a saved model can be absent, and the provider falls back. Trusting settings here
          // made the picker claim "gpt-5.6-luna · current" while the session ran on claude-sonnet-5.
          ...(opened.provider && opened.model ? { provider: opened.provider as ProviderId, model: opened.model } : {}),
          // A newly opened session starts from an empty transcript, not the previous project's.
          chat: { ...initialChatState(), messages: [{ id: "sys", role: "system", content: `Opened ${opened.workspace} · ${opened.provider}/${opened.model}` }] },
          status: "idle",
          unread: 0,
          needsApproval: false,
        });
      });
      await refreshSessions(trimmed);
      await rememberWorkspace(trimmed, openMode);
    } catch (err) {
      // A restore failing is not the user's action failing: the folder may simply have moved since
      // last launch, and shouting about it on every launch would be worse than starting quietly.
      if (!options.silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false, target);
      openingRef.current.delete(target);
    }
  }

  /**
   * Opens a session with no project folder. Returns the root it landed in, or null if it failed.
   *
   * Deliberately not silent: the transcript says which directory it landed in, because a file
   * written during a scratch chat is a real file and "where did that go" is the question that
   * follows otherwise.
   */
  async function openScratchProject(): Promise<{ root: string; tabId: string } | null> {
    const target = tabId;
    if (!target || openingRef.current.has(target)) return null;
    openingRef.current.add(target);
    setError(null);
    try {
      await ensureSidecar();
      await setSettings(props.settings);
      const opened = await openScratchSession(mode, sidecarTabId(target));
      setPathDraft(opened.root);
      setTabsState((state) => {
        const adopted = adoptTabId(state, target, opened.tabId);
        return updateTab(adopted, opened.tabId, {
          root: opened.root,
          title: opened.title,
          sessionId: opened.sessionId,
          ...(opened.provider && opened.model ? { provider: opened.provider as ProviderId, model: opened.model } : {}),
        });
      });
      addSystemMessage(`No project open — using a scratch workspace at ${opened.root}. Open a folder any time to switch.`, opened.tabId);
      return { root: opened.root, tabId: opened.tabId };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      openingRef.current.delete(target);
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
    const target = tabId;
    if (!target) return;
    // Mode belongs to the tab, not the window: reviewing in plan mode in one tab while another
    // builds is a normal way to work, and a window-wide mode would make that impossible.
    if (!root) {
      patchTab({ mode: next });
      return;
    }
    setBusy(true, target);
    try {
      const opened = await setMode(next, sidecarTabId(target));
      setTabsState((state) => updateTab(state, target, { mode: next, sessionId: opened.sessionId }));
      addSystemMessage(`Mode → ${next}`, target);
      void rememberWorkspace(root, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false, target);
    }
  }

  async function handleSend() {
    const target = tabId;
    if (!target || !draft.trim() || busy) return;
    // No project open is no longer a refusal. Asking a question is not the same act as working on a
    // repository — "how do I write this migration" needs no folder — and the app used to answer that
    // with an error telling the reader to go and open something first. A scratch session is opened
    // on demand instead, and says where it put itself so the directory is not a surprise later.
    // The opener returns the root rather than relying on `root` having updated: a state setter does
    // not change the value already captured by this closure, so reading `root` again below would
    // still be null on the very turn that created the scratch session.
    const opened = root ? { root, tabId: target } : await openScratchProject();
    if (!opened) return;
    const objective = draft.trim();
    // The tab the scratch session landed in, which is this tab under the id the sidecar gave it.
    const sendTabId = opened.tabId;
    setDraft("");
    patchChat((chat) => appendUserMessage(chat, objective), sendTabId);
    // Busy is set here rather than left to the first `turn_status: running` event, because the gap
    // between the two is a window in which the composer would still accept a second send — and it
    // is widest exactly when the engine is slowest to answer. What it is *not* is window-wide: the
    // other tabs stay live, and typing in one of them goes on working while this await runs, which
    // is the entire point.
    setBusy(true, sendTabId);
    try {
      const result = await sendTurn(objective, sidecarTabId(sendTabId));
      const cost = await getCost(sidecarTabId(sendTabId));
      const todoState = await getTodos(sidecarTabId(sendTabId));
      setTabsState((state) => updateTab(state, sendTabId, {
        sessionId: result.sessionId,
        todos: todoState.todos,
        warning: cost.warning,
        chat: {
          ...(findTab(state, sendTabId)?.chat ?? initialChatState()),
          costReport: cost.report,
          displayTotal: cost.displayTotal,
          budgetFraction: cost.budgetFraction,
        },
      }));
      await refreshSessions(opened.root);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false, sendTabId);
    }
  }

  const setSandbox = (next: boolean) => patchTab({ sandbox: next });

  async function handleUndo() {
    try {
      await undoTurn(sidecarTabId(tabId));
      addSystemMessage("Undid last turn checkpoint.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleModel(provider: ProviderId, model: string) {
    const target = tabId;
    if (!target) return;
    setBusy(true, target);
    setError(null);
    try {
      // Per tab, like the mode: a cheap model for the tab grinding through a test suite and an
      // expensive one for the tab doing the thinking is a reasonable way to spend a budget.
      await setModel(model, provider, sidecarTabId(target));
      patchTab({ provider, model }, target);
      // Said in the transcript rather than only in the header: a model change alters what every
      // later answer costs and how it reasons, so it belongs in the record of the conversation.
      addSystemMessage(`Model → ${provider}/${model}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false, target);
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
    const target = tabId;
    if (!root || !target) return;
    setBusy(true, target);
    setError(null);
    try {
      const resumed = await resumeSession(root, id, mode, sandbox, sandbox && upload, sidecarTabId(target));
      setTabsState((state) => {
        const adopted = adoptTabId(state, target, resumed.tabId);
        return updateTab(adopted, resumed.tabId, {
          sessionId: resumed.sessionId,
          // Resuming replaces this tab's transcript, same as opening: what is on screen belongs to
          // the session being left, not the one being joined. Every *other* tab is untouched.
          chat: { ...initialChatState(), messages: [{ id: "resume", role: "system", content: `Resumed ${resumed.title || resumed.sessionId}` }] },
          status: "idle",
          unread: 0,
          needsApproval: false,
        });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false, target);
    }
  }

  /**
   * A second piece of work, running at the same time.
   *
   * The new tab starts blank and unopened rather than duplicating this one: opening a session costs
   * a workspace and possibly a remote sandbox, and the common reason for a new tab is a *different*
   * project. It inherits the mode, which is the one setting people expect to carry over.
   */
  function handleNewTab() {
    setTabsState((state) => addTab(state, blankTab(`${LOCAL_TAB_ID}-${Date.now()}`, mode)));
    setPathDraft("");
    // Focus lands in the composer, because a new tab is opened to say something into.
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  async function handleSelectTab(next: string) {
    setTabsState((state) => activateLocalTab(state, next));
    const target = sidecarTabId(next);
    // Telling the sidecar which tab is in front is what makes an unaddressed request — anything
    // still calling without a tab id — mean the tab the user is actually looking at.
    if (target) await activateSidecarTab(target).catch(() => undefined);
    const nextRoot = findTab(tabsState, next)?.root;
    setPathDraft(nextRoot ?? "");
    if (nextRoot) await refreshSessions(nextRoot).catch(() => undefined);
  }

  /**
   * Closes a tab, and the session inside it.
   *
   * The session has to be released or it goes on living in the daemon — with a sandbox still
   * running and still being paid for. Closing the last tab leaves a fresh blank one rather than an
   * empty window: there is no state in which this app has nothing to type into.
   */
  async function handleCloseTab(next: string) {
    const target = sidecarTabId(next);
    setTabsState((state) => {
      const removed = removeTab(state, next);
      return removed.tabs.length > 0 ? removed : addTab(removed, blankTab(`${LOCAL_TAB_ID}-${Date.now()}`, mode));
    });
    if (target) await closeSidecarTab(target).catch(() => undefined);
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
          {/* In the header rather than only in the strip, because the strip hides itself until there
              are two tabs — and the first new tab has to be openable from a window that has one. */}
          <button className="btn ghost" type="button" onClick={handleNewTab} title="New tab — a second piece of work, running at the same time (Ctrl T)">
            + Tab
          </button>
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
          {/* Beside Settings rather than buried in a panel: the two questions a new window raises
              are "where do I put my key" and "how does this work", and they should be equally
              easy to find. */}
          <button className="btn ghost" type="button" onClick={() => setShowGuide(true)} title="How Nova works — modes, approvals, tabs, sandboxes (F1)">
            Guide
          </button>
          <button className="btn ghost" type="button" onClick={props.onOpenSettings} title="API key, budget, sandbox (Ctrl ,)">
            Settings
          </button>
        </div>
      </header>

      <TabStrip
        tabs={tabsState.tabs}
        activeTabId={tabsState.activeTabId}
        summary={describeWork(tabsState)}
        busy={false}
        onSelect={(next) => void handleSelectTab(next)}
        onClose={(next) => void handleCloseTab(next)}
        onNew={handleNewTab}
      />

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
            onCancel={() => cancelTurn(sidecarTabId(tabId))}
            onShowDiff={() => setShowDiff(true)}
            onScan={() => setShowScan(true)}
            onFiles={() => setShowFiles(true)}
            onToggleSandbox={() => {
              setSandbox(!sandbox);
              setUpload(true);
            }}
            onPull={async () => {
              try {
                const result = await pullSandbox(undefined, sidecarTabId(tabId));
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
              {/*
                * A project open and nothing asked yet.
                *
                * The transcript at this point held one line — "Opened /path · provider/model" —
                * above an empty screen the height of the window, which tells a first-time reader
                * nothing about what to ask for. The suggestions are deliberately about the project
                * in front of them rather than generic prompts, and they fill the composer instead
                * of sending, so the first message is still theirs to edit.
                */}
              {root && shouldShowStarters({ root, messageCount: messages.length, busy }) ? (
                <div className="empty-state starters">
                  <h2>Ready in {projectName(root)}</h2>
                  <p>Ask for a change, or for an explanation. Nova reads the project before it answers.</p>
                  <div className="starter-list">
                    {STARTERS.map((starter) => (
                      <button
                        key={starter}
                        className="btn ghost starter"
                        type="button"
                        onClick={() => { setDraft(starter); composerRef.current?.focus(); }}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                  <p className="starter-foot">
                    Every edit and command asks first in Build mode.{" "}
                    <button className="btn ghost tiny" type="button" onClick={() => setShowGuide(true)}>Read the guide</button>
                  </p>
                </div>
              ) : null}
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

      {/* The panels read the tab in front, so "what changed" and "which files" answer for the work
          being looked at rather than for whichever session opened last. */}
      <DiffPanel open={showDiff} onClose={() => setShowDiff(false)} tabId={sidecarTabId(tabId)} />
      <ScanPanel open={showScan} onClose={() => setShowScan(false)} tabId={sidecarTabId(tabId)} />
      <FilePanel
        tabId={sidecarTabId(tabId)}
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
      <GuidePanel open={showGuide} onClose={() => setShowGuide(false)} />
      {approval ? <ApprovalModal approval={approval} onRespond={handleApproval} /> : null}
    </div>
  );
}
