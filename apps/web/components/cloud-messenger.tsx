"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUpRight, Boxes, CheckCheck, LoaderCircle, MessageCircleMore, MessagesSquare, Pause, Play, Plus, Search, Send, Settings2, SquareTerminal, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AuthPanel, useCurrentOrganization } from "@/components/auth-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { MarkdownMessage } from "@/components/markdown-message";
import { authClient } from "@/lib/auth-client";
import { modelChoicesFor } from "@/lib/model-choices";
import { describeSandbox, orderFleet, summarizeFleet, type SandboxRow } from "@/lib/sandbox-fleet";
import { formatMs, formatUsd, percent, shapeOf, slopePerMinute, usdPerHour, utilization, type MetricSample } from "@/lib/sandbox-metrics";
import { automationCap, DEFAULT_AUTO_APPROVE_RWF } from "@/lib/automation-budget";
import { suggestNext } from "@/lib/suggestions";

// The drawer is the only part of the app that pulls the archive builder, and it is never on
// screen until someone opens a sandbox. Loading it on demand keeps that code out of first paint.
const SandboxDrawer = dynamic(() => import("@/components/sandbox-drawer").then((module) => module.SandboxDrawer), { ssr: false });

const terminalStatuses = new Set(["completed", "blocked", "cancelled"]);
/** E2B samples every five seconds, so polling faster only burns requests for the same numbers. */
const METRICS_INTERVAL_MS = 5_000;
const GIB = 1_073_741_824;
/** One minute of samples at the provider's own cadence — enough to have a direction, short
    enough that the direction is the current one. */
const TREND_WINDOW = 12;

type Sample = MetricSample & { sandboxId: string; timestamp: number };
type FleetRow = SandboxRow & { runId: Id<"agentRuns">; taskId: Id<"tasks">; taskTitle: string };

function relativeTime(timestamp?: number): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

/**
 * Load as four ratios: the three the provider reports, and the weighted composite that says how
 * close the machine as a whole is to its limit. Each bar changes colour in its last fifth, because
 * a number at 94% and a number at 41% should not look alike.
 */
function Meters({ sample }: { sample: Sample | undefined }) {
  if (!sample) return <p className="meters-pending">Metrics arrive within five seconds of the first sample.</p>;
  const load = utilization(sample);
  const rows = [
    { key: "CPU", fraction: load.cpu, read: `${percent(load.cpu)}% of ${sample.cpuCount} vCPU` },
    { key: "Memory", fraction: load.memory, read: `${(sample.memUsed / GIB).toFixed(2)} / ${(sample.memTotal / GIB).toFixed(1)} GB` },
    { key: "Disk", fraction: load.disk, read: `${(sample.diskUsed / GIB).toFixed(1)} / ${(sample.diskTotal / GIB).toFixed(0)} GB` },
    { key: "Pressure", fraction: load.pressure, read: `${percent(load.pressure)}% weighted`, composite: true },
  ];
  return <div className="meters">{rows.map((row) => <div className={`meter${row.composite ? " composite" : ""}${row.fraction > 0.85 ? " hot" : row.fraction > 0.7 ? " warn" : ""}`} key={row.key}>
    <span><b>{row.key}</b><small>{row.read}</small></span>
    <i><u style={{ width: `${percent(row.fraction)}%` }} /></i>
  </div>)}</div>;
}

/** A measured value with its label, on the same rhythm wherever it appears. */
function Readout({ items }: { items: { label: string; value: string; trend?: number }[] }) {
  return <dl className={`sandbox-insight${items.length > 3 ? " wide" : ""}`}>
    {items.map((item) => <div key={item.label}>
      <dt>{item.label}</dt>
      <dd className={item.trend === undefined || Math.abs(item.trend) < 1 ? "" : item.trend > 0 ? "up" : "down"}>{item.value}</dd>
    </div>)}
  </dl>;
}

export function CloudMessenger() {
  const session = authClient.useSession();
  const organization = useCurrentOrganization();
  const [conversationId, setConversationId] = useState<Id<"conversations"> | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [search, setSearch] = useState("");
  const [mobileView, setMobileView] = useState<"conversations" | "chat" | "sandboxes">("chat");
  const [selectedTaskId, setSelectedTaskId] = useState<Id<"tasks"> | null>(null);
  /**
   * Which tab the main pane is showing. "chat" is the conversation; anything else is a task
   * running in its own sandbox. Several sandboxes work at once, so moving between them has to be
   * a move, not a modal — a drawer that covers the conversation makes parallel work feel serial.
   */
  const [activeTab, setActiveTab] = useState<"chat" | Id<"tasks">>("chat");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [provider, setProvider] = useState<"deployment" | "openai" | "circuitnotion">("deployment");
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<"ask" | "plan" | "build">("ask");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [autoApproveRwf, setAutoApproveRwf] = useState(DEFAULT_AUTO_APPROVE_RWF);
  const [previewUrl, setPreviewUrl] = useState<{ taskId: Id<"tasks">; url: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [samples, setSamples] = useState<Record<string, Sample>>({});
  const [now, setNow] = useState(() => Date.now());
  // A short series per sandbox so the panel can say which way load is going, not only where it is.
  // A ref, not state: it is written on the same tick that already re-renders the panel.
  const trendsRef = useRef<Map<string, { t: number; v: number }[]>>(new Map());
  const endRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  /**
   * The stream element does not exist until someone is signed in, and the observers below are the
   * whole of the stick-to-bottom behaviour. Attaching them from an effect that runs once on mount
   * silently missed the element every time — the pane the reader actually uses is the one mounted
   * *after* sign-in, and by then the effect had already run against nothing. A callback ref makes
   * the node itself the trigger, so the observers attach whenever the pane appears and re-attach
   * if it is ever remounted.
   */
  const [streamNode, setStreamNode] = useState<HTMLDivElement | null>(null);
  const attachStream = useCallback((node: HTMLDivElement | null) => {
    streamRef.current = node;
    setStreamNode(node);
  }, []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // The observer callback needs the current value without re-subscribing on every scroll, so
  // the ref carries it and the state drives the UI.
  const atBottomRef = useRef(true);

  const ensureOrganization = useMutation(api.organizations.ensureOrganization);
  const membership = useQuery(api.organizations.getCurrentMembership, session.data ? {} : "skip");
  const ensureConversation = useMutation(api.messages.ensureNovaConversation);
  const createConversation = useMutation(api.messages.createNovaConversation);
  const sendToNova = useMutation(api.messages.sendToNova);
  const startLiveCodingRun = useAction(api.terminalRuns.startLiveCodingRun);
  const startSandboxPreview = useAction(api.sandboxPreviews.start);
  const readFleetMetrics = useAction(api.sandboxMetrics.fleet);
  const decideApproval = useMutation(api.approvals.decide);
  const updatePreferences = useMutation(api.settings.updateNovaPreferences);
  const pauseRun = useMutation(api.agentRuns.pauseRun);
  const resumeRun = useMutation(api.agentRuns.resumeRun);

  const scope = organization ? { organizationId: organization._id } : "skip";
  const conversations = useQuery(api.messages.listConversations, scope);
  const messages = useQuery(api.messages.listMessages, conversationId ? { conversationId } : "skip");
  const tasks = useQuery(api.tasks.listRecent, scope);
  const sandboxes = useQuery(api.sandboxes.listForOrganization, scope) as FleetRow[] | undefined;
  const stats = useQuery(api.sandboxStats.forOrganization, scope);
  const approvals = useQuery(api.approvals.listPending, scope);
  const preferences = useQuery(api.settings.getNovaPreferences, scope);

  const fleet = useMemo(() => orderFleet(sandboxes ?? []), [sandboxes]);
  const fleetSummary = useMemo(() => summarizeFleet(fleet, now), [fleet, now]);
  const hasFleet = fleet.length > 0;

  useEffect(() => {
    // Signing in on /messages never mounts AuthPanel, which is where the workspace used to be
    // created. Without this the whole surface sits on "Preparing workspace" forever.
    if (session.data && membership === null) {
      ensureOrganization().catch((error) => setNotice(error instanceof Error ? error.message : "Could not create a workspace"));
    }
  }, [ensureOrganization, membership, session.data]);

  useEffect(() => {
    if (!organization || conversationId) return;
    ensureConversation({ organizationId: organization._id })
      .then(setConversationId)
      .catch((error) => setNotice(error instanceof Error ? error.message : "Could not open Nova chat"));
  }, [conversationId, ensureConversation, organization]);

  /**
   * Seed the option fields from the server once, and again whenever the panel is opened — never on
   * every emission.
   *
   * A Convex query re-emits whenever its data changes, and re-seeding on each emission overwrote
   * whatever a person was in the middle of typing: an update landing between the edit and the save
   * silently reverted the field, and Save then wrote the old value back. Which is a data-loss bug
   * that looks exactly like "the setting didn't stick".
   */
  const applyPreferences = useCallback((stored: NonNullable<typeof preferences>) => {
    setProvider(stored.provider);
    setModelId(stored.modelId ?? "");
    setMode(stored.mode);
    setMemoryEnabled(stored.memoryEnabled);
    setAutoApproveRwf(automationCap(stored.autoApproveUnderRwf));
  }, []);
  useEffect(() => {
    // Never while the panel is open. Preferences can finish loading — or change in another tab —
    // a moment after someone starts editing, and seeding the fields then discards what they typed.
    if (!preferences || optionsOpen) return;
    applyPreferences(preferences);
  }, [applyPreferences, optionsOpen, preferences]);

  function openOptions() {
    if (preferences) applyPreferences(preferences);
    setOptionsOpen(true);
  }

  /**
   * One call per tick for the whole fleet, and none at all while the tab is hidden.
   *
   * A per-sandbox action would multiply both round trips and E2B requests by the number of
   * machines running, and a background tab is nobody's command center — it should not keep
   * paying for samples no one is reading. The same tick advances `now`, which is what makes
   * every uptime on screen count up.
   */
  const organizationId = organization?._id;
  useEffect(() => {
    if (!organizationId || !hasFleet) { setSamples({}); return; }
    let cancelled = false;
    const read = () => {
      setNow(Date.now());
      if (typeof document !== "undefined" && document.hidden) return;
      void readFleetMetrics({ organizationId })
        .then((rows) => {
          if (cancelled) return;
          for (const row of rows) {
            const series = trendsRef.current.get(row.sandboxId) ?? [];
            series.push({ t: row.timestamp, v: row.cpuUsedPct });
            trendsRef.current.set(row.sandboxId, series.slice(-TREND_WINDOW));
          }
          setSamples(Object.fromEntries(rows.map((row) => [row.sandboxId, row])));
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, METRICS_INTERVAL_MS);
    document.addEventListener("visibilitychange", read);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", read); };
  }, [hasFleet, organizationId, readFleetMetrics]);

  function handleStreamScroll() {
    const stream = streamRef.current;
    if (!stream) return;
    const bottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
    atBottomRef.current = bottom;
    setAtBottom((previous) => (previous === bottom ? previous : bottom));
  }

  // The composer grows with the message instead of hiding it behind a one-line window.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  }, [draft]);

  /**
   * Follow the bottom while the reader is already there, and never otherwise — yanking someone
   * back down while they read earlier messages is the single worst thing a chat can do.
   *
   * Keyed on the content itself rather than on message count: a streaming reply grows one token
   * at a time without the array length ever changing, so a length-keyed effect stops firing during
   * exactly the moment a reader most wants to follow. Scrolling is instant, not smooth — a smooth
   * scroll per token queues animations that fight each other and leave the view lagging behind.
   */
  useEffect(() => {
    const stream = streamNode;
    if (!stream) return;
    let frame = 0;
    // The guard is re-checked inside the frame, not only when the frame is scheduled. Content
    // arriving schedules a pin; if the reader starts scrolling up in that same frame, the scroll
    // handler clears the flag but the already-queued callback would still have hauled them back
    // to the bottom — the one thing this whole mechanism exists to avoid.
    const pin = () => {
      if (!atBottomRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!atBottomRef.current) return;
        stream.scrollTop = stream.scrollHeight;
      });
    };
    const observer = new MutationObserver(pin);
    observer.observe(stream, { childList: true, subtree: true, characterData: true });
    // Fires when the composer grows or the window resizes, both of which shrink the stream
    // without changing its content.
    const resize = new ResizeObserver(pin);
    resize.observe(stream);
    pin();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); };
  }, [streamNode]);

  // A conversation switch should land at the newest message, not wherever the previous thread
  // happened to be parked.
  useEffect(() => {
    const stream = streamNode;
    if (!stream) return;
    atBottomRef.current = true;
    setAtBottom(true);
    stream.scrollTop = stream.scrollHeight;
  }, [conversationId, streamNode]);

  // The run a person is most likely watching: the newest task still in flight. Its events stream
  // into the conversation as bubbles, so progress arrives where the conversation already is.
  const watchedTaskId = selectedTaskId ?? tasks?.find((task) => !terminalStatuses.has(task.status))?._id ?? null;
  const watchedRuns = useQuery(api.agentRuns.listForTask, watchedTaskId ? { taskId: watchedTaskId } : "skip");
  const watchedRun = useMemo(() => watchedRuns?.reduce((latest, run) => !latest || run.createdAt > latest.createdAt ? run : latest, undefined as (typeof watchedRuns)[number] | undefined), [watchedRuns]);
  const watchedDetail = useQuery(api.agentRuns.getRunDetail, watchedRun ? { runId: watchedRun._id } : "skip");
  const modelChoices = useMemo(() => provider === "deployment" ? [] : modelChoicesFor(provider), [provider]);

  const activeTasks = useMemo(() => tasks?.filter((task) => !terminalStatuses.has(task.status)) ?? [], [tasks]);
  const pendingTaskApprovals = useMemo(() => approvals?.filter((approval) => approval.kind === "task_start") ?? [], [approvals]);
  /**
   * One tab for the conversation and one for every sandbox still working. Finished tasks drop out
   * on their own: a tab bar that only grows becomes a second task list.
   */
  const tabs = useMemo(() => [
    { id: "chat" as const, label: "Nova", state: "", live: false },
    ...activeTasks.map((task) => ({ id: task._id, label: task.title, state: task.status, live: ["queued", "running"].includes(task.status) })),
  ], [activeTasks]);

  const suggestions = useMemo(() => suggestNext({
    hasWorkspace: Boolean(organization),
    draft,
    tasks: (tasks ?? []).map((task) => ({ id: task._id, title: task.title, status: task.status, blockedReason: task.execution?.stepTitle ?? undefined })),
    runningSandboxes: fleetSummary.running,
  }), [draft, fleetSummary.running, organization, tasks]);

  const visibleConversations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return conversations ?? [];
    return (conversations ?? []).filter((conversation) => `${conversation.title} ${conversation.lastMessagePreview ?? ""}`.toLowerCase().includes(needle));
  }, [conversations, search]);

  useEffect(() => {
    if (activeTab !== "chat" && !tabs.some((tab) => tab.id === activeTab)) setActiveTab("chat");
  }, [activeTab, tabs]);

  async function newConversation() {
    if (!organization) return;
    try { setConversationId(await createConversation({ organizationId: organization._id })); setSearch(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not create conversation"); }
  }

  async function savePreferences(overrides: Partial<{ provider: typeof provider; modelId: string; mode: typeof mode; memoryEnabled: boolean; autoApproveRwf: number }> = {}) {
    // The workspace is created asynchronously after sign-up. Returning quietly here meant the save
    // button did nothing at all for the first few seconds of a new account, with no way to tell.
    if (!organization) { setNotice("Preparing your workspace. Save your options again in a moment."); return; }
    const next = { provider, modelId, mode, memoryEnabled, autoApproveRwf, ...overrides };
    await updatePreferences({ organizationId: organization._id, provider: next.provider, modelId: next.modelId.trim() || undefined, mode: next.mode, memoryEnabled: next.memoryEnabled, autoApproveUnderRwf: next.autoApproveRwf });
    setProvider(next.provider); setModelId(next.modelId); setMode(next.mode); setMemoryEnabled(next.memoryEnabled); setAutoApproveRwf(next.autoApproveRwf);
    setNotice(`Nova options saved: ${next.provider}${next.modelId ? ` / ${next.modelId}` : ""} · ${next.mode} mode · memory ${next.memoryEnabled ? "on" : "off"}.`);
  }

  async function sendMessage() {
    const content = draft.trim();
    if (!content || sending) return;
    // Commands drive the client and the workspace, not the thread, so they must work before a
    // conversation exists — that is exactly when someone reaches for /options or /provider.
    if (content.startsWith("/")) {
      const [command, first, ...rest] = content.slice(1).split(/\s+/);
      setDraft("");
      if (command === "new") return void newConversation();
      if (["sandboxes", "activity", "tasks"].includes(command)) { setMobileView("sandboxes"); return; }
      if (command === "options" || command === "models") { openOptions(); return; }
      if (command === "mode" && ["ask", "plan", "build"].includes(first)) { await savePreferences({ mode: first as "ask" | "plan" | "build" }); return; }
      if (command === "memory" && ["on", "off"].includes(first)) { await savePreferences({ memoryEnabled: first === "on" }); return; }
      if (command === "provider" && ["deployment", "openai", "circuitnotion"].includes(first)) { await savePreferences({ provider: first as typeof provider, modelId: rest.join(" ") }); return; }
      setNotice("Unknown command. Try /new, /sandboxes, /options, /mode, /memory, or /provider.");
      return;
    }
    if (!conversationId) return;
    setDraft("");
    setSending(true);
    setNotice(null);
    try {
      await sendToNova({ conversationId, content, clientMessageId: crypto.randomUUID() });
    } catch (error) {
      setDraft(content);
      setNotice(error instanceof Error ? error.message : "Message was not sent");
    } finally {
      setSending(false);
    }
  }

  async function startCloudTask() {
    const objective = draft.trim();
    if (!objective || starting) return;
    // The workspace is provisioned asynchronously after sign-up. Saying so beats a dead button:
    // several tasks can be queued back to back once it exists, and none of them cancel each other.
    if (!organization) { setNotice("Preparing your workspace. Start the sandbox again in a moment."); return; }
    setStarting(true);
    setNotice(null);
    try {
      const result = await startLiveCodingRun({ organizationId: organization._id, objective, idempotencyKey: crypto.randomUUID() });
      setDraft("");
      setNotice(result.quote.maxRwf <= autoApproveRwf
        ? `Started — quoted at up to ${result.quote.maxRwf.toLocaleString()} RWF, within your ${autoApproveRwf.toLocaleString()} RWF automation ceiling.`
        : `Quoted at up to ${result.quote.maxRwf.toLocaleString()} RWF, above your ${autoApproveRwf.toLocaleString()} RWF ceiling. Approve it to start.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Sandbox could not be created");
    } finally {
      setStarting(false);
    }
  }

  const openPreview = useCallback(async (runId: Id<"agentRuns">, taskId: Id<"tasks">) => {
    setPreviewLoading(true);
    setSelectedTaskId(taskId);
    try {
      const result = await startSandboxPreview({ runId });
      setPreviewUrl({ taskId, url: result.url });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Preview could not start");
    } finally {
      setPreviewLoading(false);
    }
  }, [startSandboxPreview]);

  async function approve(approvalId: Id<"approvals">) {
    const result = await decideApproval({ approvalId, decision: "approved" });
    setNotice(result.outcome === "payment_authorization_required"
      ? "Approved, but a real payment authorization is still required before E2B can start."
      : "Approved. The sandbox is starting.");
  }

  if (!session.data) {
    return <main className="messenger-auth">
      <span className="messenger-wordmark">CIRCUIT·NOVA</span>
      <section>
        <span className="nova-orbit"><Boxes /></span>
        <p className="overline">E2B COMMAND CENTER</p>
        <h1>Your sandboxes keep working.</h1>
        <p>Sign in to message Nova and watch every cloud sandbox it runs, from any device.</p>
        <AuthPanel />
      </section>
    </main>;
  }

  const selectedTask = tasks?.find((task) => task._id === selectedTaskId);
  const watchedTask = tasks?.find((task) => task._id === watchedTaskId);
  const watchedSample = watchedRun?.sandboxId ? samples[watchedRun.sandboxId] : undefined;

  return <main className={`messenger-shell mobile-${mobileView}`}>
    <aside className="conversation-rail">
      <header className="rail-head">
        <span className="messenger-wordmark">CIRCUIT·NOVA</span>
        <div className="rail-actions"><button aria-label="New conversation" onClick={newConversation}><Plus /></button></div>
      </header>
      <label className="search-box"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" /></label>
      <div className="rail-filter"><span>ALL CONVERSATIONS</span></div>
      <div className="conversation-list">
        {visibleConversations.map((conversation) => <button className={`conversation-row${conversation._id === conversationId ? " active" : ""}`} key={conversation._id} onClick={() => { setConversationId(conversation._id); setMobileView("chat"); }}>
          <span className="nova-avatar">N</span>
          <span className="conversation-copy">
            <span><strong>{conversation.title}</strong><time>{relativeTime(conversation.lastMessageAt)}</time></span>
            <small>{conversation.lastMessagePreview ?? "Cloud assistant"}</small>
          </span>
        </button>)}
        {conversations === undefined && <div className="rail-loading"><LoaderCircle /> Opening conversations…</div>}
      </div>
      <footer className="rail-footer">
        <span className="member-avatar">{session.data.user.email?.slice(0, 1).toUpperCase()}</span>
        <span><b>{organization?.name ?? "Preparing workspace"}</b><small>{session.data.user.email}</small></span>
      </footer>
    </aside>

    <section className="chat-pane">
      <header className="chat-head">
        <span className="nova-avatar large">N</span>
        <span><strong>Nova</strong><small><i /> connected · {mode} mode · {provider === "deployment" ? "managed model" : provider}</small></span>
        <div>
          {modelChoices.length > 0 && <select className="model-quick" aria-label="Model" value={modelId} onChange={(event) => void savePreferences({ modelId: event.target.value })}>
            <option value="">{provider} default</option>
            {modelChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.id}{choice.inputRate ? ` · ${Math.round(choice.inputRate).toLocaleString()} ${choice.currency}/M` : ""}</option>)}
          </select>}
          <button className="options-toggle" onClick={openOptions} aria-label="Nova options"><Settings2 /></button>
          <ThemeToggle />
        </div>
      </header>

      {tabs.length > 1 && <div className="workspace-tabs" role="tablist" aria-label="Open workspaces">
        {tabs.map((tab) => <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTab}
          className={`workspace-tab${tab.id === activeTab ? " active" : ""}`}
          onClick={() => setActiveTab(tab.id as "chat" | Id<"tasks">)}
        >
          {tab.id === "chat" ? <MessageCircleMore /> : <span className={`task-dot ${tab.state}`} />}
          <b>{tab.label}</b>
          {tab.live && <i className="tab-pulse" aria-label="running" />}
        </button>)}
      </div>}

      <div className="message-stream" ref={attachStream} onScroll={handleStreamScroll} hidden={activeTab !== "chat"}>
        <div className="encryption-note"><Boxes /> Durable conversation · every sandbox is quoted and approved first</div>
        {(messages ?? []).map((message) => <article className={`message-bubble ${message.sender}${message.status === "failed" ? " failed" : ""}`} key={message._id}>
          {message.status === "generating"
            ? <span className="typing"><i /><i /><i /></span>
            : message.sender === "nova" ? <MarkdownMessage content={message.content} /> : <p>{message.content}</p>}
          <footer><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{message.sender === "user" && <CheckCheck />}</footer>
        </article>)}
        {messages === undefined && <div className="stream-loading"><LoaderCircle /> Loading durable history…</div>}
        {messages?.length === 0 && <p className="stream-empty">Describe what you want built. Nova answers here, and anything that needs a machine runs in an E2B sandbox you can watch and stop.</p>}

        {pendingTaskApprovals.map((approval) => {
          const task = tasks?.find((item) => item._id === approval.taskId);
          return <article className="chat-approval" key={approval._id}>
            <p className="overline">APPROVE TO START A SANDBOX</p>
            <h4>{task?.title ?? "Cloud sandbox"}</h4>
            <p>Up to {Number(approval.requestedRwf ?? 0n).toLocaleString()} RWF. Nothing has run yet.</p>
            <div>
              <button onClick={() => decideApproval({ approvalId: approval._id, decision: "rejected" })}>Decline</button>
              <button className="approve" onClick={() => approve(approval._id)}>Approve &amp; run</button>
            </div>
          </article>;
        })}

        {watchedDetail && watchedRun && <section className="run-feed" aria-label="Live sandbox activity">
          <header className="run-feed-head">
            <span className={`task-dot ${watchedRun.status}`} />
            <b>{watchedTask?.title ?? "Cloud sandbox"}</b>
            <em className={`run-state ${watchedRun.status}`}>{statusLabel(watchedRun.status)}</em>
          </header>
          <Readout items={[
            { label: "Sandbox", value: watchedRun.sandboxId ? `${watchedRun.sandboxId.slice(0, 12)}…` : "not started" },
            { label: "Step", value: `${watchedDetail.steps.filter((step) => step.status === "completed").length}/${watchedDetail.steps.length}` },
            { label: "Heartbeat", value: watchedTask?.execution?.heartbeatAt ? relativeTime(watchedTask.execution.heartbeatAt) : "—" },
          ]} />
          {watchedRun.sandboxId && <Meters sample={watchedSample} />}
          {watchedDetail.events.slice(-6).map((event) => <article className="event-bubble" key={event._id}>
            <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            <p>{event.message}</p>
          </article>)}
          {["queued", "running"].includes(watchedRun.status) && <div className="thinking"><span className="thinking-dots"><i /><i /><i /></span>working in the sandbox</div>}
        </section>}

        {/* The only element allowed to be a scroll anchor. Browsers that support scroll anchoring
            keep it in view for free, which absorbs the reflow when a code block finishes laying
            out; the observer above covers Safari, which does not implement it. */}
        <div ref={endRef} className="scroll-anchor" aria-hidden="true" />
      </div>


      {activeTab !== "chat" && <div className="tab-body">
        <SandboxDrawer
          inline
          taskId={activeTab}
          title={tasks?.find((task) => task._id === activeTab)?.title ?? "Cloud sandbox"}
          status={statusLabel(tasks?.find((task) => task._id === activeTab)?.status ?? "loading")}
          runs={[]}
          previewUrl={previewUrl?.taskId === activeTab ? previewUrl.url : null}
          previewLoading={previewLoading}
          onSelectRun={(id) => setActiveTab(id)}
          onStartPreview={(runId) => void openPreview(runId, activeTab)}
          onPause={(runId) => void pauseRun({ runId })}
          onResume={(runId) => void resumeRun({ runId })}
          onNotice={setNotice}
          onClose={() => setActiveTab("chat")}
        />
      </div>}

      {/* Scrolls the stream itself rather than asking the browser to bring the anchor into view:
          scrollIntoView is defined against "is it visible", which is not the same question as
          "is the thread at its end", and it left the pane parked where it was.
          Instant, not smooth: setting atBottom re-arms the pin observer, and an in-flight smooth
          animation then finishes against its own stale target — which stopped the thread a nav
          bar's height short of the end on a phone. */}
      {activeTab === "chat" && !atBottom && <button className="jump-latest" onClick={() => {
        atBottomRef.current = true;
        setAtBottom(true);
        if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
      }}><ArrowDown /> Latest</button>}

      <div className="composer-wrap">
        {notice && <p className="composer-notice">{notice}</p>}
        {suggestions.length > 0 && <div className="suggestions" aria-label="Suggested next steps">
          {suggestions.map((suggestion) => <button
            key={suggestion.label}
            className={`suggestion ${suggestion.kind}`}
            onClick={() => {
              if (suggestion.prompt) { setDraft(suggestion.prompt); composerRef.current?.focus(); return; }
              if (suggestion.taskId) setActiveTab(suggestion.taskId as Id<"tasks">);
              else composerRef.current?.focus();
            }}
          >{suggestion.label}</button>)}
        </div>}
        <div className="composer">
          <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} rows={1} placeholder="Message Nova or type /options" />
          <button className="send" onClick={sendMessage} disabled={!draft.trim() || sending} aria-label="Send message">{sending ? <LoaderCircle /> : <Send />}</button>
        </div>
        <button className="cloud-task-button" onClick={startCloudTask} disabled={!draft.trim() || starting}><SquareTerminal />{starting ? "Creating quote…" : "Run this in a cloud sandbox"}</button>
        <small className="composer-hint">Enter sends · Shift + Enter adds a line · Sandboxes under {autoApproveRwf.toLocaleString()} RWF start immediately</small>
      </div>
    </section>

    <aside className="cloud-rail">
      <header>
        <span><p className="overline">E2B COMMAND CENTER</p><h2>Sandboxes</h2></span>
        <span className={`cloud-health${fleetSummary.running ? " busy" : ""}`}>
          {fleetSummary.running ? `${fleetSummary.running} running` : fleetSummary.total ? `${fleetSummary.total} idle` : "None live"}
        </span>
      </header>

      {/* Nine measurements, each defined once in lib/sandbox-metrics and computed either from a
          live provider sample or, for anything that spans runs, by the query itself. */}
      <div className="cloud-metrics">
        <div><span>Live</span><b>{fleetSummary.total}</b><small>{fleetSummary.running} running · {fleetSummary.idle} idle</small></div>
        <div><span>Billed</span><b>{stats ? formatMs(stats.billedMs) : "—"}</b><small>{stats ? `${percent(stats.billingEfficiency)}% of uptime` : "—"}</small></div>
        <div><span>Spent</span><b>{stats ? formatUsd(stats.usdSpent) : "—"}</b><small>{stats ? `${formatUsd(stats.usdPerHourLive)}/h live` : "—"}</small></div>
        <div><span>Steps</span><b>{stats ? `${stats.steps.completed}/${stats.steps.total}` : "—"}</b><small>{stats ? `${percent(stats.steps.progress)}% complete` : "—"}</small></div>
        <div><span>Success</span><b>{stats ? `${percent(stats.steps.successRate)}%` : "—"}</b><small>{stats ? `${stats.steps.failed} failed` : "—"}</small></div>
        <div><span>Retries</span><b>{stats ? stats.steps.retryRate.toFixed(2) : "—"}</b><small>per step</small></div>
        <div><span>Mean step</span><b>{stats ? formatMs(stats.steps.meanStepMs) : "—"}</b><small>{stats ? `p95 ${formatMs(stats.steps.p95StepMs)}` : "—"}</small></div>
        <div><span>Throughput</span><b>{stats ? stats.steps.throughputPerHour.toFixed(1) : "—"}</b><small>steps / hour</small></div>
        <div><span>Mean run</span><b>{stats ? formatMs(stats.meanRunMs) : "—"}</b><small>{stats ? `p95 ${formatMs(stats.p95RunMs)}` : "—"}</small></div>
      </div>

      {pendingTaskApprovals.length > 0 && <section className="approval-stack">
        <p className="section-label">NEEDS YOUR APPROVAL</p>
        {pendingTaskApprovals.map((approval) => {
          const task = tasks?.find((item) => item._id === approval.taskId);
          return <article className="approval-card" key={approval._id}>
            <span>PRICE GATE</span>
            <h3>{task?.title ?? "Cloud sandbox"}</h3>
            <p>Up to {Number(approval.requestedRwf ?? 0n).toLocaleString()} RWF. Nothing has run yet.</p>
            <div>
              <button onClick={() => decideApproval({ approvalId: approval._id, decision: "rejected" })}>Decline</button>
              <button className="approve" onClick={() => approve(approval._id)}>Approve</button>
            </div>
          </article>;
        })}
      </section>}

      <section className="fleet-stack">
        <p className="section-label">SANDBOX FLEET</p>
        {fleet.map((box) => {
          const detail = describeSandbox(box, now);
          const cpuTrend = slopePerMinute(trendsRef.current.get(box.sandboxId) ?? []);
          return <article className={`sandbox-card ${detail.state}`} key={box.sandboxId}>
            <header>
              <span className={`task-dot ${detail.state}`} />
              <code title={box.sandboxId || "waiting for E2B"}>{box.sandboxId || "provisioning…"}</code>
              <em className={`run-state ${detail.state}`}>{detail.state}</em>
            </header>
            <h3>{box.taskTitle}</h3>
            <p className="sandbox-step">{detail.activity}</p>
            <Readout items={[
              { label: "Template", value: detail.template },
              { label: "Uptime", value: detail.uptime },
              { label: "Billed", value: detail.billed },
              // Positive is rising CPU. Under a point per minute is noise, and is shown flat.
              { label: "CPU trend", value: `${cpuTrend >= 0 ? "+" : ""}${cpuTrend.toFixed(1)}%/m`, trend: cpuTrend },
              { label: "Rate", value: `${formatUsd(usdPerHour(shapeOf(samples[box.sandboxId])))}/h` },
              { label: "Efficiency", value: `${percent(detail.efficiency)}%` },
            ]} />
            {detail.state !== "starting" && <Meters sample={samples[box.sandboxId]} />}
            <div className="sandbox-actions">
              <button onClick={() => openPreview(box.runId, box.taskId)} disabled={previewLoading || detail.state === "starting"}><ArrowUpRight /> Preview</button>
              {detail.state === "paused"
                ? <button onClick={() => resumeRun({ runId: box.runId })}><Play /> Resume</button>
                : <button onClick={() => pauseRun({ runId: box.runId })}><Pause /> Pause</button>}
              <button onClick={() => setSelectedTaskId(box.taskId)}><SquareTerminal /> Open</button>
            </div>
          </article>;
        })}
        {sandboxes !== undefined && fleet.length === 0 && <div className="empty-cloud">
          <Boxes /><p>No sandboxes running.</p><small>Describe what to build, then choose “Run this in a cloud sandbox”.</small>
        </div>}
      </section>

      <section className="task-stack">
        <p className="section-label">RECENT TASKS</p>
        {(tasks ?? []).map((task) => {
          const progress = task.execution ? Math.round((task.execution.completedSteps / Math.max(1, task.execution.totalSteps)) * 100) : task.status === "completed" ? 100 : 0;
          return <article className="task-card" key={task._id}>
            <header>
              <span className={`task-dot ${task.status}`} />
              <span><h3>{task.title}</h3><p>{statusLabel(task.status)}</p></span>
              <b>{progress}%</b>
            </header>
            <div className="progress"><i style={{ width: `${progress}%` }} /></div>
            <button className="view-output" onClick={() => setSelectedTaskId(task._id)}><SquareTerminal /> Open sandbox <ArrowUpRight /></button>
          </article>;
        })}
      </section>
    </aside>

    <nav className="mobile-nav" aria-label="Messenger views">
      <button className={mobileView === "conversations" ? "active" : ""} onClick={() => setMobileView("conversations")}><MessagesSquare /><span>Chats</span></button>
      <button className={mobileView === "chat" ? "active" : ""} onClick={() => setMobileView("chat")}><MessageCircleMore /><span>Nova</span></button>
      <button className={mobileView === "sandboxes" ? "active" : ""} onClick={() => setMobileView("sandboxes")}><Boxes /><span>Sandboxes</span>{fleetSummary.total > 0 && <i>{fleetSummary.total}</i>}</button>
    </nav>

    {selectedTaskId && <SandboxDrawer
      taskId={selectedTaskId}
      title={selectedTask?.title ?? "Cloud sandbox"}
      status={selectedTask ? statusLabel(selectedTask.status) : "loading"}
      runs={activeTasks.map((task) => ({ id: task._id, title: task.title, state: task.status }))}
      previewUrl={previewUrl?.taskId === selectedTaskId ? previewUrl.url : null}
      previewLoading={previewLoading}
      onSelectRun={setSelectedTaskId}
      onStartPreview={(runId) => void openPreview(runId, selectedTaskId)}
      onPause={(runId) => void pauseRun({ runId })}
      onResume={(runId) => void resumeRun({ runId })}
      onNotice={setNotice}
      onClose={() => setSelectedTaskId(null)}
    />}

    {optionsOpen && <div className="options-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOptionsOpen(false); }}>
      <section className="options-panel" role="dialog" aria-modal="true" aria-label="Nova options">
        <header><div><p className="overline">NOVA COMMAND CENTER</p><h2>Options</h2></div><button onClick={() => setOptionsOpen(false)} aria-label="Close options"><X /></button></header>
        <div className="option-group">
          <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}>
            <option value="deployment">Deployment managed</option>
            <option value="openai">OpenAI</option>
            <option value="circuitnotion">CircuitNotion</option>
          </select></label>
          <label>Model ID<input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={provider === "deployment" ? "Uses deployment default" : "Provider model ID"} disabled={provider === "deployment"} /></label>
          <small>Credentials stay deployment-managed and are never entered in this browser.</small>
        </div>
        <div className="option-group"><p>Mode</p><div className="segmented">{(["ask", "plan", "build"] as const).map((value) => <button className={mode === value ? "active" : ""} onClick={() => setMode(value)} key={value}>{value}</button>)}</div></div>
        <label className="switch-row"><span><b>Conversation memory</b><small>Use earlier messages in this thread</small></span><input type="checkbox" checked={memoryEnabled} onChange={(event) => setMemoryEnabled(event.target.checked)} /></label>
        <div className="option-group">
          <label>Run without asking, up to
            <input type="number" min={0} max={10_000_000} step={500} value={autoApproveRwf} onChange={(event) => setAutoApproveRwf(Number(event.target.value))} />
          </label>
          <small>Sandboxes quoted at or under this start the moment you ask, the way the CLI does. Anything above it still stops for your approval, and a budget overage always does. Set it to 0 to approve every sandbox by hand.</small>
        </div>
        <div className="option-links">
          <button onClick={() => { setOptionsOpen(false); void newConversation(); }}><MessagesSquare /> New resumable thread</button>
          <button onClick={() => { setOptionsOpen(false); setMobileView("sandboxes"); }}><Boxes /> Sandboxes, approvals &amp; spend</button>
        </div>
        <div className="command-list"><p className="section-label">CLI COMMANDS IN CHAT</p><code>/new</code><code>/sandboxes</code><code>/mode build</code><code>/memory off</code><code>/provider openai MODEL_ID</code></div>
        <footer>
          <button onClick={() => setOptionsOpen(false)}>Cancel</button>
          <button className="save-options" onClick={async () => { try { await savePreferences(); setOptionsOpen(false); } catch (error) { setNotice(error instanceof Error ? error.message : "Options were not saved"); } }}>Save options</button>
        </footer>
      </section>
    </div>}
  </main>;
}
