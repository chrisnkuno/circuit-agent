"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { Activity, ArrowDown, ArrowUpRight, CheckCheck, Cloud, FileText, LoaderCircle, MessageCircleMore, MessagesSquare, Pause, Play, Plus, Search, Send, Settings2, SquareTerminal, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AuthPanel, useCurrentOrganization } from "@/components/auth-panel";
import { DownloadWorkButton } from "@/components/download-work-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { authClient } from "@/lib/auth-client";
import { modelChoicesFor } from "@/lib/model-choices";
import { MarkdownMessage } from "@/components/markdown-message";

const terminalStatuses = new Set(["completed", "blocked", "cancelled"]);

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

export function CloudMessenger() {
  const session = authClient.useSession();
  const organization = useCurrentOrganization();
  const [conversationId, setConversationId] = useState<Id<"conversations"> | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [search, setSearch] = useState("");
  // Sandbox first: when work is running, the sandbox is the thing worth looking at.
  const [mobileView, setMobileView] = useState<"conversations" | "chat" | "activity">("chat");
  const [selectedTaskId, setSelectedTaskId] = useState<Id<"tasks"> | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [provider, setProvider] = useState<"deployment" | "openai" | "circuitnotion">("deployment");
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<"ask" | "plan" | "build">("ask");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<{ taskId: Id<"tasks">; url: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [metrics, setMetrics] = useState<{ cpuUsedPct: number; cpuCount: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number } | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // The observer callback needs the current value without re-subscribing on
  // every scroll, so the ref carries it and the state drives the UI.
  const atBottomRef = useRef(true);

  const ensureOrganization = useMutation(api.organizations.ensureOrganization);
  const membership = useQuery(api.organizations.getCurrentMembership, session.data ? {} : "skip");
  const ensureConversation = useMutation(api.messages.ensureNovaConversation);
  const createConversation = useMutation(api.messages.createNovaConversation);
  const sendToNova = useMutation(api.messages.sendToNova);
  const startLiveCodingRun = useAction(api.terminalRuns.startLiveCodingRun);
  const startSandboxPreview = useAction(api.sandboxPreviews.start);
  const readSandboxMetrics = useAction(api.sandboxMetrics.latest);
  const decideApproval = useMutation(api.approvals.decide);
  const updatePreferences = useMutation(api.settings.updateNovaPreferences);
  const pauseRun = useMutation(api.agentRuns.pauseRun);
  const resumeRun = useMutation(api.agentRuns.resumeRun);
  const conversations = useQuery(api.messages.listConversations, organization ? { organizationId: organization._id } : "skip");
  const messages = useQuery(api.messages.listMessages, conversationId ? { conversationId } : "skip");
  const tasks = useQuery(api.tasks.listRecent, organization ? { organizationId: organization._id } : "skip");
  const sandboxes = useQuery(api.sandboxes.listForOrganization, organization ? { organizationId: organization._id } : "skip");
  const usage = useQuery(api.sandboxes.usageForOrganization, organization ? { organizationId: organization._id } : "skip");
  const approvals = useQuery(api.approvals.listPending, organization ? { organizationId: organization._id } : "skip");
  const preferences = useQuery(api.settings.getNovaPreferences, organization ? { organizationId: organization._id } : "skip");
  const selectedArtifacts = useQuery(api.artifacts.listForTask, selectedTaskId ? { taskId: selectedTaskId } : "skip");
  const selectedRuns = useQuery(api.agentRuns.listForTask, selectedTaskId ? { taskId: selectedTaskId } : "skip");
  const latestSelectedRun = useMemo(() => selectedRuns?.reduce((latest, run) => !latest || run.createdAt > latest.createdAt ? run : latest, undefined as (typeof selectedRuns)[number] | undefined), [selectedRuns]);
  const selectedRunDetail = useQuery(api.agentRuns.getRunDetail, latestSelectedRun ? { runId: latestSelectedRun._id } : "skip");

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

  function handleStreamScroll() {
    const stream = streamRef.current;
    if (!stream) return;
    const distance = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    const bottom = distance < 80;
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

  useEffect(() => {
    if (!preferences) return;
    setProvider(preferences.provider);
    setModelId(preferences.modelId ?? "");
    setMode(preferences.mode);
    setMemoryEnabled(preferences.memoryEnabled);
  }, [preferences]);

  // The run a person is most likely watching: the newest task still in flight. Its events stream
  // into the conversation as bubbles, so progress arrives where the conversation already is.
  const watchedTaskId = selectedTaskId ?? tasks?.find((task) => !terminalStatuses.has(task.status))?._id ?? null;
  const watchedRuns = useQuery(api.agentRuns.listForTask, watchedTaskId ? { taskId: watchedTaskId } : "skip");
  const watchedRun = useMemo(() => watchedRuns?.reduce((latest, run) => !latest || run.createdAt > latest.createdAt ? run : latest, undefined as (typeof watchedRuns)[number] | undefined), [watchedRuns]);
  const watchedDetail = useQuery(api.agentRuns.getRunDetail, watchedRun ? { runId: watchedRun._id } : "skip");
  const modelChoices = useMemo(() => provider === "deployment" ? [] : modelChoicesFor(provider), [provider]);

  const activeTasks = useMemo(() => tasks?.filter((task) => !terminalStatuses.has(task.status)) ?? [], [tasks]);
  const pendingTaskApprovals = useMemo(() => approvals?.filter((approval) => approval.kind === "task_start") ?? [], [approvals]);
  const visibleConversations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return conversations ?? [];
    return (conversations ?? []).filter((conversation) => `${conversation.title} ${conversation.lastMessagePreview ?? ""}`.toLowerCase().includes(needle));
  }, [conversations, search]);

  // Follow the bottom while the reader is already there, and never otherwise —
  // yanking someone back down while they read earlier messages is the single
  // worst thing a chat can do.
  //
  // Keyed on the content itself rather than on message count. A streaming reply
  // grows one token at a time without the array length ever changing, so the
  // old length-keyed effect stopped firing during exactly the moment a reader
  // most wants to follow: the answer arriving. A MutationObserver watching
  // characterData sees each token land.
  //
  // Scrolling is instant, not smooth. A smooth scroll per token queues
  // animations that fight each other and leave the view lagging behind the
  // text. Smooth is right for a deliberate jump, which is why the Latest
  // button still uses it.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    let frame = 0;
    const pin = () => {
      if (!atBottomRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
    };
    const observer = new MutationObserver(pin);
    observer.observe(stream, { childList: true, subtree: true, characterData: true });
    // Fires when the composer grows or the window resizes, both of which shrink
    // the stream without changing its content.
    const resize = new ResizeObserver(pin);
    resize.observe(stream);
    pin();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); };
  }, []);

  // A conversation switch should land at the newest message, not wherever the
  // previous thread happened to be parked.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    atBottomRef.current = true;
    setAtBottom(true);
    stream.scrollTop = stream.scrollHeight;
  }, [conversationId]);

  // E2B samples every five seconds, so polling faster only burns requests for the same numbers.
  useEffect(() => {
    const runId = watchedRun?._id;
    const live = watchedRun && ["queued", "running"].includes(watchedRun.status) && Boolean(watchedRun.sandboxId);
    if (!runId || !live) { setMetrics(null); return; }
    let cancelled = false;
    const read = () => { void readSandboxMetrics({ runId }).then((sample) => { if (!cancelled) setMetrics(sample); }).catch(() => undefined); };
    read();
    const timer = setInterval(read, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [readSandboxMetrics, watchedRun?._id, watchedRun?.status, watchedRun?.sandboxId]);

  async function newConversation() {
    if (!organization) return;
    try { setConversationId(await createConversation({ organizationId: organization._id })); setSearch(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not create conversation"); }
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
      if (command === "activity" || command === "tasks") { setMobileView("activity"); return; }
      if (command === "options" || command === "models") { setOptionsOpen(true); return; }
      if (command === "mode" && ["ask", "plan", "build"].includes(first)) { await savePreferences({ mode: first as "ask" | "plan" | "build" }); return; }
      if (command === "memory" && ["on", "off"].includes(first)) { await savePreferences({ memoryEnabled: first === "on" }); return; }
      if (command === "provider" && ["deployment", "openai", "circuitnotion"].includes(first)) { await savePreferences({ provider: first as typeof provider, modelId: rest.join(" ") }); return; }
      setNotice("Unknown command. Try /new, /tasks, /options, /mode, /memory, or /provider.");
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

  async function savePreferences(overrides: Partial<{ provider: typeof provider; modelId: string; mode: typeof mode; memoryEnabled: boolean }> = {}) {
    if (!organization) return;
    const next = { provider, modelId, mode, memoryEnabled, ...overrides };
    await updatePreferences({ organizationId: organization._id, provider: next.provider, modelId: next.modelId.trim() || undefined, mode: next.mode, memoryEnabled: next.memoryEnabled });
    setProvider(next.provider); setModelId(next.modelId); setMode(next.mode); setMemoryEnabled(next.memoryEnabled);
    setNotice(`Nova options saved: ${next.provider}${next.modelId ? ` / ${next.modelId}` : ""} · ${next.mode} mode · memory ${next.memoryEnabled ? "on" : "off"}.`);
  }

  async function startCloudTask() {
    const objective = draft.trim();
    if (!objective || starting) return;
    // The workspace is provisioned asynchronously after sign-up. Saying so beats a dead button:
    // several tasks can be queued back to back once it exists, and none of them cancel each other.
    if (!organization) { setNotice("Preparing your workspace. Start the cloud task again in a moment."); return; }
    setStarting(true);
    setNotice(null);
    try {
      const result = await startLiveCodingRun({ organizationId: organization._id, objective, idempotencyKey: crypto.randomUUID() });
      setDraft("");
      setNotice(`Cloud task quoted at up to ${result.quote.maxRwf.toLocaleString()} RWF. Approve it in Cloud activity before E2B starts.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cloud task could not be created");
    } finally {
      setStarting(false);
    }
  }

  if (!session.data) {
    return <main className="messenger-auth">
      <Link href="/" className="messenger-wordmark">CIRCUIT·NOVA</Link>
      <section><span className="nova-orbit"><MessageCircleMore /></span><p className="overline">NOVA CLOUD</p><h1>Your work keeps moving.</h1><p>Sign in to message Nova and watch independent E2B tasks from any device.</p><AuthPanel /></section>
    </main>;
  }

  const selectedTask = tasks?.find((task) => task._id === selectedTaskId);
  const watchedTask = tasks?.find((task) => task._id === watchedTaskId);

  return <main className={`messenger-shell mobile-${mobileView}`}>
    <aside className="conversation-rail">
      <header className="rail-head"><Link href="/" className="messenger-wordmark">CIRCUIT·NOVA</Link><div className="rail-actions"><button aria-label="New conversation" onClick={newConversation}><Plus /></button></div></header>
      <label className="search-box"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" /></label>
      <div className="rail-filter"><span>ALL CONVERSATIONS</span></div>
      <div className="conversation-list">
        {visibleConversations.map((conversation) => <button className={`conversation-row${conversation._id === conversationId ? " active" : ""}`} key={conversation._id} onClick={() => { setConversationId(conversation._id); setMobileView("chat"); }}>
          <span className="nova-avatar">N</span><span className="conversation-copy"><span><strong>{conversation.title}</strong><time>{relativeTime(conversation.lastMessageAt)}</time></span><small>{conversation.lastMessagePreview ?? "Cloud assistant"}</small></span>
        </button>)}
        {conversations === undefined && <div className="rail-loading"><LoaderCircle /> Opening conversations…</div>}
      </div>
      <footer className="rail-footer"><span className="member-avatar">{session.data.user.email?.slice(0, 1).toUpperCase()}</span><span><b>{organization?.name ?? "Preparing workspace"}</b><small>{session.data.user.email}</small></span></footer>
    </aside>

    <section className="chat-pane">
      <header className="chat-head"><span className="nova-avatar large">N</span><span><strong>Nova</strong><small><i /> connected · {mode} mode · {provider === "deployment" ? "managed model" : provider}</small></span><div>{modelChoices.length > 0 && <select className="model-quick" aria-label="Model" value={modelId} onChange={(event) => void savePreferences({ modelId: event.target.value })}>
        <option value="">{provider} default</option>
        {modelChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.id}{choice.inputRate ? ` · ${Math.round(choice.inputRate).toLocaleString()} ${choice.currency}/M` : ""}</option>)}
      </select>}<button className="options-toggle" onClick={() => setOptionsOpen(true)} aria-label="Nova options"><Settings2 /></button><ThemeToggle /><Link href="/" aria-label="Home">Home</Link></div></header>
      <div className="message-stream" ref={streamRef} onScroll={handleStreamScroll}>
        <div className="encryption-note"><Cloud /> Durable conversation · task actions remain approval-gated</div>
        {(messages ?? []).map((message) => <article className={`message-bubble ${message.sender}${message.status === "failed" ? " failed" : ""}`} key={message._id}>
          {message.status === "generating"
            ? <span className="typing"><i /><i /><i /></span>
            : message.sender === "nova" ? <MarkdownMessage content={message.content} /> : <p>{message.content}</p>}
          <footer><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{message.sender === "user" && <CheckCheck />}</footer>
        </article>)}
        {messages === undefined && <div className="stream-loading"><LoaderCircle /> Loading durable history…</div>}
        {pendingTaskApprovals.map((approval) => {
          const task = tasks?.find((item) => item._id === approval.taskId);
          return <article className="chat-approval" key={approval._id}>
            <p className="overline">APPROVE TO START</p>
            <h4>{task?.title ?? "Cloud task"}</h4>
            <p>Up to {Number(approval.requestedRwf ?? 0n).toLocaleString()} RWF. Nothing has run yet.</p>
            <div>
              <button onClick={() => decideApproval({ approvalId: approval._id, decision: "rejected" })}>Decline</button>
              <button className="approve" onClick={async () => { const result = await decideApproval({ approvalId: approval._id, decision: "approved" }); setNotice(result.outcome === "payment_authorization_required" ? "Approved, but a real payment authorization is still required before E2B can start." : "Approved. The sandbox is starting."); }}>Approve &amp; run</button>
            </div>
          </article>;
        })}
        {watchedDetail && watchedRun && <section className="run-feed" aria-label="Cloud run activity">
          <header className="run-feed-head">
            <span className={`task-dot ${watchedRun.status}`} />
            <b>{watchedTask?.title ?? "Cloud run"}</b>
            <em className={`run-state ${watchedRun.status}`}>{statusLabel(watchedRun.status)}</em>
          </header>
          <dl className="sandbox-insight">
            <div><dt>Sandbox</dt><dd>{watchedRun.sandboxId ? `${watchedRun.sandboxId.slice(0, 12)}…` : "not started"}</dd></div>
            <div><dt>Step</dt><dd>{watchedDetail.steps.filter((step) => step.status === "completed").length}/{watchedDetail.steps.length}</dd></div>
            <div><dt>Heartbeat</dt><dd>{watchedTask?.execution?.heartbeatAt ? relativeTime(watchedTask.execution.heartbeatAt) : "—"}</dd></div>
          </dl>
          {metrics && <div className="meters">
            {[
              { label: "CPU", value: metrics.cpuUsedPct / 100, read: `${Math.round(metrics.cpuUsedPct)}% of ${metrics.cpuCount} vCPU` },
              { label: "Memory", value: metrics.memTotal ? metrics.memUsed / metrics.memTotal : 0, read: `${(metrics.memUsed / 1_073_741_824).toFixed(2)} / ${(metrics.memTotal / 1_073_741_824).toFixed(1)} GB` },
              { label: "Disk", value: metrics.diskTotal ? metrics.diskUsed / metrics.diskTotal : 0, read: `${(metrics.diskUsed / 1_073_741_824).toFixed(1)} / ${(metrics.diskTotal / 1_073_741_824).toFixed(0)} GB` },
            ].map((meter) => <div className="meter" key={meter.label}>
              <span><b>{meter.label}</b><small>{meter.read}</small></span>
              <i><u style={{ width: `${Math.min(100, Math.max(0, meter.value * 100))}%` }} /></i>
            </div>)}
          </div>}
          {watchedDetail.events.slice(-6).map((event) => <article className="event-bubble" key={event._id}>
            <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            <p>{event.message}</p>
          </article>)}
          {["queued", "running"].includes(watchedRun.status) && <div className="thinking"><span className="thinking-dots"><i /><i /><i /></span>working in the sandbox</div>}
        </section>}
        {/* The only element allowed to be a scroll anchor. Browsers that
            support scroll anchoring keep it in view for free, which absorbs
            the reflow when a code block or image finishes laying out; the
            observer above covers Safari, which does not implement it. */}
        <div ref={endRef} className="scroll-anchor" aria-hidden="true" />
      </div>
      {activeTasks.length > 0 && <div className="active-strip" role="list" aria-label="Running cloud tasks">
        {activeTasks.map((task) => <button role="listitem" key={task._id} className={`active-chip${task._id === selectedTaskId ? " open" : ""}`} onClick={() => setSelectedTaskId(task._id)}>
          <span className={`task-dot ${task.status}`} /><b>{task.title}</b><small>{task.execution?.stepTitle ?? statusLabel(task.status)}</small>
        </button>)}
      </div>}
      {!atBottom && <button className="jump-latest" onClick={() => {
        atBottomRef.current = true;
        setAtBottom(true);
        endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      }}><ArrowDown /> Latest</button>}
      <div className="composer-wrap">
        {notice && <p className="composer-notice">{notice}</p>}
        <div className="composer"><textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} rows={1} placeholder="Message Nova or type /options" /><button className="send" onClick={sendMessage} disabled={!draft.trim() || sending} aria-label="Send message">{sending ? <LoaderCircle /> : <Send />}</button></div>
        <button className="cloud-task-button" onClick={startCloudTask} disabled={!draft.trim() || starting}><SquareTerminal />{starting ? "Creating quote…" : "Start cloud task from this message"}</button>
        <small className="composer-hint">Enter sends · Shift + Enter adds a line · Cloud tasks are quoted before execution</small>
      </div>
    </section>

    <aside className="cloud-rail">
      <header><span><p className="overline">LIVE CONTROL PLANE</p><h2>Cloud activity</h2></span><span className={`cloud-health${activeTasks.length ? " busy" : ""}`}>{activeTasks.length ? `${activeTasks.length} active` : "Idle"}</span></header>
      <div className="cloud-metrics"><div><span>Live sandboxes</span><b>{sandboxes?.length ?? 0}</b></div><div><span>Runtime</span><b>{usage ? `${Math.round(usage.sandboxMs / 1_000)}s` : "—"}</b></div><div><span>Est. E2B</span><b>{usage ? `$${usage.estimatedUsd.toFixed(4)}` : "—"}</b></div></div>
      {pendingTaskApprovals.length > 0 && <section className="approval-stack"><p className="section-label">NEEDS YOUR APPROVAL</p>{pendingTaskApprovals.map((approval) => {
        const task = tasks?.find((item) => item._id === approval.taskId);
        return <article className="approval-card" key={approval._id}><span>PRICE GATE</span><h3>{task?.title ?? "Cloud task"}</h3><p>Up to {Number(approval.requestedRwf ?? 0n).toLocaleString()} RWF. Nothing has run yet.</p><div><button onClick={() => decideApproval({ approvalId: approval._id, decision: "rejected" })}>Decline</button><button className="approve" onClick={async () => { const result = await decideApproval({ approvalId: approval._id, decision: "approved" }); setNotice(result.outcome === "payment_authorization_required" ? "Approved, but a real payment authorization is still required before E2B can start." : "Approved. The dispatcher is picking up the task."); }}>Approve</button></div></article>;
      })}</section>}
      <section className="task-stack"><p className="section-label">RECENT TASKS</p>{(tasks ?? []).map((task) => {
        const progress = task.execution ? Math.round((task.execution.completedSteps / Math.max(1, task.execution.totalSteps)) * 100) : task.status === "completed" ? 100 : 0;
        return <article className="task-card" key={task._id}><header><span className={`task-dot ${task.status}`} /><span><h3>{task.title}</h3><p>{statusLabel(task.status)}</p></span><b>{progress}%</b></header><div className="progress"><i style={{ width: `${progress}%` }} /></div>{task.execution && <div className="execution-detail"><span>{task.execution.stepTitle ?? "Waiting for next step"}</span><small>{task.execution.sandboxId ? `E2B ${task.execution.sandboxId.slice(0, 10)}…` : "Sandbox suspended"}{task.execution.heartbeatAt ? ` · heartbeat ${relativeTime(task.execution.heartbeatAt)}` : ""}</small></div>}<button className="view-output" onClick={() => setSelectedTaskId(task._id)}><FileText /> View live output <ArrowUpRight /></button></article>;
      })}{tasks?.length === 0 && <div className="empty-cloud"><Cloud /><p>No cloud tasks yet.</p><small>Type an objective, then choose Start cloud task.</small></div>}</section>
    </aside>

    <nav className="mobile-nav" aria-label="Messenger views">
      <button className={mobileView === "conversations" ? "active" : ""} onClick={() => setMobileView("conversations")}><MessagesSquare /><span>Chats</span></button>
      <button className={mobileView === "chat" ? "active" : ""} onClick={() => setMobileView("chat")}><MessageCircleMore /><span>Nova</span></button>
      <button className={mobileView === "activity" ? "active" : ""} onClick={() => setMobileView("activity")}><Activity /><span>Activity</span>{activeTasks.length > 0 && <i>{activeTasks.length}</i>}</button>
    </nav>

    {selectedTaskId && <div className="output-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTaskId(null); }}>
      <section className="output-panel" role="dialog" aria-modal="true" aria-label="Task output">
        <header><div><p className="overline">LIVE TASK OUTPUT</p><h2>{selectedTask?.title ?? "Cloud task"}</h2><span>{selectedTask ? statusLabel(selectedTask.status) : "loading"}{latestSelectedRun ? ` · run ${latestSelectedRun._id.slice(0, 8)}` : ""}</span></div><button onClick={() => setSelectedTaskId(null)} aria-label="Close output"><X /></button></header>
        {activeTasks.length > 1 && <div className="output-switcher" role="tablist" aria-label="Running tasks">
          {activeTasks.map((task) => <button role="tab" key={task._id} aria-selected={task._id === selectedTaskId} className={task._id === selectedTaskId ? "active" : ""} onClick={() => setSelectedTaskId(task._id)}>
            <span className={`task-dot ${task.status}`} />{task.title}
          </button>)}
        </div>}
        <div className="output-actions"><DownloadWorkButton taskId={selectedTaskId} className="download-output" label="Download all output" onNotice={({ text }) => setNotice(text)} />{latestSelectedRun?.sandboxId && <button className="run-control" disabled={previewLoading} onClick={async () => { setPreviewLoading(true); try { const result = await startSandboxPreview({ runId: latestSelectedRun._id }); setPreviewUrl({ taskId: selectedTaskId, url: result.url }); } catch (error) { setNotice(error instanceof Error ? error.message : "Preview could not start"); } finally { setPreviewLoading(false); } }}><ArrowUpRight /> {previewLoading ? "Starting preview…" : "Live preview"}</button>}{latestSelectedRun?.status === "paused" ? <button className="run-control" onClick={() => resumeRun({ runId: latestSelectedRun._id })}><Play /> Resume sandbox</button> : latestSelectedRun && ["queued", "running"].includes(latestSelectedRun.status) ? <button className="run-control" onClick={() => pauseRun({ runId: latestSelectedRun._id })}><Pause /> Pause sandbox</button> : null}<small>Updates automatically while E2B continues.</small></div>
        {previewUrl?.taskId === selectedTaskId && <section className="live-preview"><header><span><b>INTERACTIVE SANDBOX PREVIEW</b><small>Ephemeral E2B port 3000 · isolated frame</small></span><a href={previewUrl.url} target="_blank" rel="noreferrer">Open full screen <ArrowUpRight /></a></header><iframe src={previewUrl.url} title="Generated app preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" /></section>}
        <div className="output-grid">
          <section><p className="section-label">FILES & EVIDENCE</p>{selectedArtifacts === undefined ? <div className="output-loading"><LoaderCircle /> Reading output…</div> : selectedArtifacts.length === 0 ? <p className="output-empty">No files yet. Output appears here as cloud steps finish.</p> : <ul className="artifact-list">{[...selectedArtifacts].sort((a, b) => b.createdAt - a.createdAt).map((artifact) => <li key={artifact.id}><span><FileText /><b>{artifact.path ?? artifact.kind.replaceAll("_", " ")}</b><small>{artifact.stepTitle ?? "Run evidence"} · {Math.max(1, Math.round(artifact.byteLength / 1024))} KB</small></span>{artifact.url ? <a href={artifact.url} target="_blank" rel="noreferrer">Open <ArrowUpRight /></a> : <em>Metadata only</em>}</li>)}</ul>}</section>
          <section><p className="section-label">RUN TIMELINE</p>{selectedRunDetail === undefined ? <div className="output-loading"><LoaderCircle /> Reading timeline…</div> : !selectedRunDetail ? <p className="output-empty">No execution run exists yet.</p> : <><ol className="step-list">{selectedRunDetail.steps.map((step) => <li key={step._id}><i className={`task-dot ${step.status}`} /><span><b>{step.title}</b><small>{statusLabel(step.status)}{step.summary ? ` · ${step.summary}` : ""}</small></span></li>)}</ol><ol className="event-list">{[...selectedRunDetail.events].reverse().slice(0, 10).map((event) => <li key={event._id}><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><p>{event.message}</p></li>)}</ol></>}</section>
        </div>
      </section>
    </div>}

    {optionsOpen && <div className="options-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOptionsOpen(false); }}><section className="options-panel" role="dialog" aria-modal="true" aria-label="Nova options">
      <header><div><p className="overline">NOVA COMMAND CENTER</p><h2>Options</h2></div><button onClick={() => setOptionsOpen(false)} aria-label="Close options"><X /></button></header>
      <div className="option-group"><label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="deployment">Deployment managed</option><option value="openai">OpenAI</option><option value="circuitnotion">CircuitNotion</option></select></label><label>Model ID<input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={provider === "deployment" ? "Uses deployment default" : "Provider model ID"} disabled={provider === "deployment"} /></label><small>Credentials stay deployment-managed and are never entered in this browser.</small></div>
      <div className="option-group"><p>Mode</p><div className="segmented">{(["ask", "plan", "build"] as const).map((value) => <button className={mode === value ? "active" : ""} onClick={() => setMode(value)} key={value}>{value}</button>)}</div></div>
      <label className="switch-row"><span><b>Conversation memory</b><small>Use earlier messages in this thread</small></span><input type="checkbox" checked={memoryEnabled} onChange={(event) => setMemoryEnabled(event.target.checked)} /></label>
      <div className="option-links"><button onClick={() => { setOptionsOpen(false); void newConversation(); }}><MessagesSquare /> New resumable thread</button><button onClick={() => { setOptionsOpen(false); setMobileView("activity"); }}><Activity /> Tasks, payments & sandboxes</button></div>
      <div className="command-list"><p className="section-label">CLI COMMANDS IN CHAT</p><code>/new</code><code>/tasks</code><code>/mode build</code><code>/memory off</code><code>/provider openai MODEL_ID</code></div>
      <footer><button onClick={() => setOptionsOpen(false)}>Cancel</button><button className="save-options" onClick={async () => { try { await savePreferences(); setOptionsOpen(false); } catch (error) { setNotice(error instanceof Error ? error.message : "Options were not saved"); } }}>Save options</button></footer>
    </section></div>}
  </main>;
}
