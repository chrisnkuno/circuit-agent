import { useEffect, useMemo, useRef, useState } from "react";
import { ApprovalModal, type ApprovalState } from "../components/ApprovalModal";
import { CostPanel } from "../components/CostPanel";
import { ActivityPanel } from "../components/ActivityPanel";
import { ChangesPanel } from "../components/ChangesPanel";
import { ModeBar } from "../components/ModeBar";
import { SessionList, type SessionSummary } from "../components/SessionList";
import { Message } from "../components/Message";
import { ModelPicker } from "../components/ModelPicker";
import { DiffPanel } from "../components/DiffPanel";
import { ScanPanel } from "../components/ScanPanel";
import { GuidePanel } from "../components/GuidePanel";
import { FilePanel } from "../components/FilePanel";
import { ToolsPanel } from "../components/ToolsPanel";
import { MemoryPanel } from "../components/MemoryPanel";
import { CommandPalette, type DesktopCommand } from "../components/CommandPalette";
import { sendsOnKey } from "../lib/composer";
import { projectName } from "../lib/starters";
import { SuggestionBar } from "../components/SuggestionBar";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Separator } from "../components/ui/separator";
import {
  composerSuggestions,
  recoverySuggestions,
  changedFilePaths,
  starters,
  type DesktopSessionState,
  type Suggestion,
} from "../lib/suggestions";
import { DESKTOP_PROVIDERS } from "../lib/models";
import { shouldFollow } from "../lib/transcript";
import type { BalanceReading } from "../lib/spend";
import { SHORTCUTS, isTypingTarget, matchShortcut } from "../lib/shortcuts";
import {
  activateTab as activateSidecarTab,
  cancelTurn,
  closeTab as closeSidecarTab,
  ensureSidecar,
  getBalance,
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
import { Tooltip } from "../components/ui/tooltip";
import { providerIsConfigured } from "../lib/settings";
import type { NovaMode, NovaSettings, PermissionDecision, ProviderId, RestoreScope } from "../lib/settings";

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
  /**
   * Remembers the model chosen from the picker as the one to open with next time.
   *
   * Without this the picker changed the tab in front and nothing else: the next launch, and every
   * new tab, went back to whatever Settings last saved. The CLI has always remembered the last
   * model chosen, and "the model I want" is not a per-session preference.
   */
  onDefaultModel: (provider: ProviderId, model: string) => void;
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
  /** One balance for the window: it is one account, however many tabs are open. */
  const [balanceState, setBalanceState] = useState<{
    configured: boolean;
    balance?: BalanceReading;
    unavailable?: string;
  }>({ configured: false });
  const [checkingBalance, setCheckingBalance] = useState(false);
  /** Revealed by default: the number is the point. Hiding is for a shared screen, and is a choice. */
  const [balanceRevealed, setBalanceRevealed] = useState(true);
  /** Projects opened before, most recent first, so past work is reachable without re-finding it. */
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  /**
   * Suggestions this session has already acted on.
   *
   * Window-scoped and never persisted, for the same reason the CLI's command history is: a row
   * whose contents depend on work you have since forgotten is a row you cannot learn. What it buys
   * is the one property that separates advice from noise — a suggestion you have taken stops being
   * offered.
   */
  const [takenSuggestions, setTakenSuggestions] = useState<readonly string[]>([]);

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
  const { messages, activity, approval, costReport, displayTotal, budgetFraction, costTurns, error } = chat;
  const changedPaths = changedFilePaths(activity);

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

  /** Which providers have a key, so the picker can say "needs a key" rather than fail a turn later. */
  const configuredProviders = useMemo(
    () => new Set(DESKTOP_PROVIDERS.filter((provider) => providerIsConfigured(props.settings, provider))),
    [props.settings],
  );

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
      if (approval || showDiff || showScan || showFiles || showGuide || showTools || showMemory || showPalette) return;
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
        case "palette": setShowPalette(true); break;
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
      void refreshBalance();
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
          costTurns: cost.turns ?? [],
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

  /**
   * The balance, refreshed after every turn and when the window opens.
   *
   * Held once for the window rather than per tab: it is one account, and four tabs each showing
   * their own idea of the same balance is four chances to disagree. Refreshed *after* a turn
   * because that is the moment it changed and the moment someone looks.
   */
  async function refreshBalance() {
    try {
      const result = await getBalance();
      setBalanceState({
        configured: result.configured,
        balance: result.balance,
        unavailable: result.unavailable,
      });
    } catch {
      // Never surfaced as an error banner. A billing service that is down must not make the app
      // look broken, and the panel already says the balance is unavailable in words.
    }
  }

  useEffect(() => { void refreshBalance(); }, []);

  /**
   * The balance check someone asked for.
   *
   * Separate from `refreshBalance` only in that it shows it is working. A button that reports
   * nothing while it runs is one people press three times, and each press is a request to a
   * billing service.
   */
  async function handleCheckBalance() {
    if (checkingBalance) return;
    setCheckingBalance(true);
    try {
      await refreshBalance();
    } finally {
      setCheckingBalance(false);
    }
  }

  async function handleUndo(scope: RestoreScope = "both") {
    const target = tabId;
    if (!target) return;
    setBusy(true, target);
    try {
      const result = await undoTurn(scope, sidecarTabId(target));
      if (!result.undone) {
        addSystemMessage("Nothing to undo.", target);
        return;
      }
      if (scope !== "code") {
        patchChat((chat) => ({
          ...initialChatState(),
          messages: [...result.transcript, { id: `undo-${Date.now()}`, role: "system", content: scope === "both" ? "Undid the last turn's files and conversation." : "Undid the last conversation turn; files were kept." }],
          diffStat: result.diffStat,
          workspaceRevision: (chat.workspaceRevision ?? 0) + 1,
        }), target);
      } else {
        addSystemMessage("Undid the last turn's file changes; conversation was kept.", target);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false, target);
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
      // Recorded only after the engine accepted it, so a rejected switch cannot become the default
      // that greets you next launch.
      props.onDefaultModel(provider, model);
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
      const [todoState, cost] = await Promise.all([
        getTodos(resumed.tabId),
        getCost(resumed.tabId),
      ]);
      setTabsState((state) => {
        const adopted = adoptTabId(state, target, resumed.tabId);
        return updateTab(adopted, resumed.tabId, {
          sessionId: resumed.sessionId,
          todos: todoState.todos,
          warning: cost.warning,
          // Resuming replaces this tab's transcript, same as opening: what is on screen belongs to
          // the session being left, not the one being joined. Every *other* tab is untouched.
          chat: {
            ...initialChatState(),
            messages: [...resumed.transcript, { id: "resume", role: "system", content: `Resumed ${resumed.title || resumed.sessionId}` }],
            diffStat: resumed.diffStat,
            workspaceRevision: 1,
            costReport: cost.report,
            displayTotal: cost.displayTotal,
            budgetFraction: cost.budgetFraction,
            costTurns: cost.turns ?? [],
          },
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

  /** Copying a sandbox back down, shared by the mode bar's button and the suggestion that offers it. */
  async function handlePull() {
    try {
      const result = await pullSandbox(undefined, sidecarTabId(tabId));
      addSystemMessage(`Pulled sandbox to ${result.dest}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Where this window is, as the signals the shared rules take.
   *
   * Assembled at render rather than kept in state, for the reason the CLI gives for the same
   * decision: every field here already lives somewhere that owns it, and a second copy is one more
   * thing to keep in step — which is how a "smart" suggestion starts describing a session that
   * ended two turns ago.
   */
  const sessionState: DesktopSessionState = {
    chat,
    root,
    mode,
    tabs: tabsState.tabs.length,
    sandbox,
    openTodos: todos.filter((todo) => todo.status !== "done").length,
    providerConfigured: Boolean(props.settings.apiKey),
    busy,
    taken: takenSuggestions,
  };

  /**
   * Taking a suggestion.
   *
   * A prompt fills the composer and never sends: the suggestion is an offer to say something, and
   * turning it into a sent message would be a decision made on the reader's behalf — including for
   * "try that again", where the whole question is whether the same request is still what they want.
   * Everything else is a thing the window can do directly, mapped from the closed set of action ids
   * the engine is allowed to name, so a rule pointing somewhere this app cannot go is a type error
   * rather than a dead button.
   */
  async function takeSuggestion(suggestion: Suggestion) {
    setTakenSuggestions((taken) => [suggestion.id, ...taken.filter((id) => id !== suggestion.id)]);
    if (suggestion.action.kind === "prompt") {
      setDraft(suggestion.action.text);
      composerRef.current?.focus();
      return;
    }
    // Slash commands belong to the terminal. A rule with only a command has no desktop action and
    // is filtered out before it reaches here; this keeps that true if one ever slips through.
    if (suggestion.action.kind === "command") return;
    switch (suggestion.action.id) {
      case "open-settings": props.onOpenSettings(); return;
      case "open-project": await chooseProject(); return;
      case "open-diff": setShowDiff(true); return;
      case "open-scan": setShowScan(true); return;
      case "open-files": setShowFiles(true); return;
      case "open-guide": setShowGuide(true); return;
      case "open-models": setModelMenuOpen(true); return;
      case "open-sessions": if (root) await refreshSessions(root); return;
      case "undo-turn": await handleUndo(); return;
      case "pull-sandbox": await handlePull(); return;
      case "new-tab": handleNewTab(); return;
      case "mode-plan": await handleMode("plan"); return;
      case "mode-build": await handleMode("build"); return;
      case "mode-auto": await handleMode("auto"); return;
      case "mode-defender": await handleMode("defender"); return;
      case "retry-turn": {
        // The last thing asked, back in the composer for a second look. What failed was the
        // attempt, not necessarily the request — and the reader is the one who knows which.
        const lastAsked = [...messages].reverse().find((message) => message.role === "user");
        if (lastAsked) {
          setDraft(lastAsked.content);
          composerRef.current?.focus();
        }
        return;
      }
      case "dismiss-error": setError(null); return;
    }
  }

  const nextSuggestions = composerSuggestions(sessionState);
  const recovery = recoverySuggestions(sessionState);
  const openingStarters = starters(sessionState);
  const commands: DesktopCommand[] = [
    { id: "diff", label: "Review changes", description: "Open the current unified diff", shortcut: "Ctrl D", disabled: !root, run: () => setShowDiff(true) },
    { id: "files", label: "Browse files", description: "Read a file or add it to the prompt", shortcut: "Ctrl P", disabled: !root, run: () => setShowFiles(true) },
    { id: "tools", label: "Inspect tools and extensions", description: "Built-ins, skills, plugins, MCP servers and hooks", disabled: !root, run: () => setShowTools(true) },
    { id: "memory", label: "Manage memory", description: "Project and personal facts shared with Nova CLI", disabled: !root, run: () => setShowMemory(true) },
    { id: "scan", label: "Scan for secrets", description: "Deterministic workspace scan with no model turn", disabled: !root, run: () => setShowScan(true) },
    { id: "undo", label: "Undo last turn", description: "Restore files and conversation", shortcut: "Ctrl Z", disabled: !root || busy, run: () => void handleUndo("both") },
    { id: "models", label: "Switch model", description: "Choose from the providers configured now", shortcut: "Ctrl M", disabled: busy, run: () => setModelMenuOpen(true) },
    { id: "plan", label: "Plan mode", description: "Read and reason without writes", shortcut: "Alt 1", disabled: busy || mode === "plan", run: () => void handleMode("plan") },
    { id: "build", label: "Build mode", description: "Ask before edits and commands", shortcut: "Alt 2", disabled: busy || mode === "build", run: () => void handleMode("build") },
    { id: "auto", label: "Auto mode", description: "Apply ordinary workspace edits", shortcut: "Alt 3", disabled: busy || mode === "auto", run: () => void handleMode("auto") },
    { id: "defender", label: "Defender mode", description: "Security review with approvals", shortcut: "Alt 4", disabled: busy || mode === "defender", run: () => void handleMode("defender") },
    { id: "new-tab", label: "New tab", description: "Start another piece of work in parallel", shortcut: "Ctrl T", run: handleNewTab },
    { id: "guide", label: "Open guide", description: "Modes, approvals, sessions and shortcuts", shortcut: "F1", run: () => setShowGuide(true) },
    { id: "settings", label: "Open settings", description: "Providers, credentials, budget and sandbox", shortcut: "Ctrl ,", run: props.onOpenSettings },
  ];

  return (
    <div className="app-shell">
      {/*
        * One line, three zones, and the verticals of the layout start here.
        *
        * The wordmark occupies exactly the width of the left rail below it, so the rail's edge is a
        * line that runs the full height of the window rather than starting under the header. The
        * middle zone is the *address* — where this session is working — and it is given the slack,
        * because it is the only part whose content has no fixed length. The right zone is the
        * cluster of things you go to rather than look at, in order of how often: model, then the
        * three that open something, then appearance.
        */}
      <header className="topbar">
        <div className="wordmark">
          <strong>Nova</strong>
        </div>

        <div className="locus">
          <span className={`status-dot ${busy ? "busy" : "live"}`} aria-hidden="true" />
          <input
            className="path-input"
            value={pathDraft}
            aria-label="Project folder"
            placeholder={root ?? "/path/to/project"}
            disabled={busy}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void openProjectAt(pathDraft);
              }
            }}
          />
          <Button onClick={() => void openProjectAt(pathDraft)} disabled={busy || !pathDraft.trim()}>
            Open
          </Button>
          <Tooltip label="Pick a folder with the system dialog">
            <Button variant="ghost" onClick={() => void chooseProject()} disabled={busy}>
              Browse…
            </Button>
          </Tooltip>
          {/* The session id, in the type it is: an identifier you copy into a bug report, never a
              phrase you read. Mono and dim keeps it available without letting it compete with the
              path, which is the thing a person is actually reading this line for. */}
          {sessionId ? <code className="locus-id" title={sessionId}>{sessionId}</code> : null}
        </div>

        <div className="topbar-actions">
          <ModelPicker
            provider={active.provider}
            model={active.model}
            busy={busy}
            configured={configuredProviders}
            onPick={handleModel}
            onNeedsKey={() => props.onOpenSettings()}
            open={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
          />
          <Separator orientation="vertical" className="topbar-rule" />
          <Tooltip label="Search every action by what it does (Ctrl G)">
            <Button variant="ghost" onClick={() => setShowPalette(true)}>Commands</Button>
          </Tooltip>
          <Tooltip label="A second piece of work, running at the same time (Ctrl T)">
            <Button variant="ghost" onClick={handleNewTab} aria-label="New tab">
              + Tab
            </Button>
          </Tooltip>
          {/* Beside Settings rather than buried in a panel: the two questions a new window raises
              are "where do I put my key" and "how does this work", and they should be equally
              easy to find. */}
          <Tooltip label="How Nova works — modes, approvals, tabs, sandboxes (F1)">
            <Button variant="ghost" onClick={() => setShowGuide(true)}>Guide</Button>
          </Tooltip>
          <Tooltip label="API key, budget, sandbox (Ctrl ,)">
            <Button variant="ghost" onClick={props.onOpenSettings}>Settings</Button>
          </Tooltip>
          <ThemeToggle />
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
            onMode={handleMode}
            onUndo={handleUndo}
            onCancel={() => cancelTurn(sidecarTabId(tabId))}
            onShowDiff={() => setShowDiff(true)}
            onScan={() => setShowScan(true)}
            onFiles={() => setShowFiles(true)}
          />

          <div className="transcript-wrap">
            {/* Radix's viewport is the element that actually scrolls, so the ref and the scroll
                handler go there: "follow new output only while the reader is at the bottom" is a
                question about the viewport, not about the frame around it. */}
            <ScrollArea
              className="transcript-scroll"
              viewportRef={transcriptRef}
              onViewportScroll={handleTranscriptScroll}
            >
              <div className="transcript">
              {!root ? (
                <div className="empty-state">
                  <h2>No project open</h2>
                  <p>Nova works inside a folder on this machine. Choose one to start a session.</p>
                  <Button variant="primary" onClick={() => void chooseProject()} disabled={busy}>
                    Browse for a folder…
                  </Button>
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
              {openingStarters.length > 0 ? (
                <div className="empty-state starters">
                  <h2>Ready in {root ? projectName(root) : "Nova"}</h2>
                  <p>Ask for a change, or for an explanation. Nova reads the project before it answers.</p>
                  <div className="starter-list">
                    {openingStarters.map((starter) => (
                      <Button
                        key={starter.id}
                        variant="ghost"
                        className="starter"
                        title={starter.reason}
                        onClick={() => void takeSuggestion(starter)}
                      >
                        {starter.label}
                      </Button>
                    ))}
                  </div>
                  <p className="starter-foot">
                    Every edit and command asks first in Build mode.{" "}
                    <Button variant="ghost" size="sm" onClick={() => setShowGuide(true)}>Read the guide</Button>
                  </p>
                </div>
              ) : null}
              {error ? (
                <div className="notice danger" role="alert">
                  <strong>Something went wrong</strong>
                  {/* Dismiss sits on the title's own row, at the end of it: it is the least
                      important control in the notice and should not be the last word in it. */}
                  <Button variant="ghost" size="sm" className="notice-dismiss" onClick={() => setError(null)}>
                    Dismiss
                  </Button>
                  <span>{error}</span>
                  {/* An error says what broke; these say what to do about it, which is the sentence
                      the reader actually needs. They appear only for a failure the rules recognise —
                      a "try again" under an unrecognised error is a guess dressed as a diagnosis. */}
                  {recovery.length > 0 ? (
                    <SuggestionBar suggestions={recovery} onTake={(suggestion) => void takeSuggestion(suggestion)} label="Try this" />
                  ) : null}
                </div>
              ) : null}
              </div>
            </ScrollArea>

            {/* Announced to assistive tech without being shown twice: the transcript itself is not a
                live region, because re-announcing the whole thing on every streamed token is noise. */}
            <p className="sr-only" aria-live="polite">{busy ? "Nova is working." : "Ready."}</p>

            {pinned ? (
              <Button className="jump-latest" onClick={jumpToLatest}>
                Jump to latest ↓
              </Button>
            ) : null}
          </div>

          {/* The one place the reader's attention already is when "what now?" arrives: the instant a
              turn ends and the cursor is back. The same question answered in a side panel is
              answered where nobody is looking. */}
          <SuggestionBar suggestions={nextSuggestions} onTake={(suggestion) => void takeSuggestion(suggestion)} />

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
              <Button variant="primary" disabled={busy || !draft.trim()} onClick={handleSend}>
                {busy ? "Working…" : "Send"}
              </Button>
              <kbd className="composer-hint">↵ send · ⇧↵ newline</kbd>
            </div>
          </div>
        </section>

        {/*
          * One column, one scrollbar.
          *
          * Each region used to flex for height against its neighbours, so with four of them open
          * every one was clipped mid-row: the activity log lost its last line to the plan's header,
          * and the cost report ended in the middle of a figure. Regions are now the height of their
          * contents and the column scrolls as a whole — with the activity list capped, since it is
          * the only one that grows without bound.
          */}
        <aside className="side-panel">
          <ScrollArea className="inspector-scroll">
          {/* What it is doing right now, above what it intends to do next. Both were previously
              answerable only by reading the transcript, which is where the answer scrolls away. */}
          <ActivityPanel entries={activity} busy={busy} progress={chat.progress} />

          <ChangesPanel
            diffStat={chat.diffStat}
            paths={changedPaths}
            busy={busy}
            onReview={() => setShowDiff(true)}
            onFiles={() => setShowFiles(true)}
          />

          <div className="panel capabilities-panel">
            <div className="panel-header">Context</div>
            <div className="panel-body">
              <p className="panel-empty">See what Nova can call and the durable facts it shares with the CLI.</p>
              <div className="btn-group">
                <Button variant="ghost" size="sm" disabled={!root} onClick={() => setShowTools(true)}>Tools</Button>
                <Button variant="ghost" size="sm" disabled={!root} onClick={() => setShowMemory(true)}>Memory</Button>
              </div>
            </div>
          </div>

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
            </div>
          </div>

          {/*
            * Where the work runs.
            *
            * It used to be a toggle in the toolbar above the transcript, next to actions you take on
            * a turn. It is not one of those: it is a property of the session, changed perhaps once a
            * day, and it belongs beside the status it decides. Here the choice and its consequences
            * — uploaded or empty, and how to get the files back — are one region instead of three
            * controls in two places.
            */}
          <div className="panel">
            <div className="panel-header">Machine</div>
            <div className="panel-body">
              <ToggleGroup
                type="single"
                value={sandbox ? "sandbox" : "local"}
                aria-label="Where the work runs"
                disabled={busy}
                onValueChange={(next) => {
                  if (!next) return;
                  setSandbox(next === "sandbox");
                  setUpload(true);
                }}
              >
                <ToggleGroupItem value="local">This machine</ToggleGroupItem>
                <ToggleGroupItem value="sandbox">Sandbox</ToggleGroupItem>
              </ToggleGroup>
              {sandbox ? (
                <div className="sandbox-note">
                  <span>{upload ? "The project is uploaded to a remote machine." : "Starting empty — nothing uploaded."}</span>
                  <div className="btn-group">
                    <Button variant="ghost" size="sm" onClick={() => setUpload((v) => !v)}>
                      {upload ? "Start empty instead" : "Upload the project"}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void handlePull()}>
                      Pull files
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="panel-empty">Files are read and written here, in {root ? projectName(root) : "the open project"}.</p>
              )}
            </div>
          </div>
          <CostPanel
            report={costReport}
            displayTotal={displayTotal}
            budgetFraction={budgetFraction}
            warning={warning}
            turns={costTurns}
            balance={balanceState.balance}
            balanceUnavailable={balanceState.unavailable}
            billingConfigured={balanceState.configured}
            onCheckBalance={() => void handleCheckBalance()}
            checkingBalance={checkingBalance}
            balanceRevealed={balanceRevealed}
            onToggleBalance={() => setBalanceRevealed((shown) => !shown)}
          />

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
          </ScrollArea>
        </aside>
      </div>

      {/* The panels read the tab in front, so "what changed" and "which files" answer for the work
          being looked at rather than for whichever session opened last. */}
      <DiffPanel open={showDiff} onClose={() => setShowDiff(false)} tabId={sidecarTabId(tabId)} refreshKey={chat.workspaceRevision} />
      <ScanPanel open={showScan} onClose={() => setShowScan(false)} tabId={sidecarTabId(tabId)} />
      <FilePanel
        tabId={sidecarTabId(tabId)}
        refreshKey={chat.workspaceRevision}
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
      <ToolsPanel open={showTools} onClose={() => setShowTools(false)} tabId={sidecarTabId(tabId)} />
      <MemoryPanel open={showMemory} onClose={() => setShowMemory(false)} tabId={sidecarTabId(tabId)} />
      <CommandPalette open={showPalette} onClose={() => setShowPalette(false)} commands={commands} />
      {approval ? <ApprovalModal approval={approval} onRespond={handleApproval} /> : null}
    </div>
  );
}
