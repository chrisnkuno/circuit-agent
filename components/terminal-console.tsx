"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/lib/auth-client";
import { useCurrentOrganization } from "@/components/auth-panel";
import { hasPermission } from "@/lib/authz";
import { formatRwf } from "@/lib/task-cost";
import { presetContextKey } from "@/lib/dynamic-presets";
import { DEFAULT_WORKSPACE_PRESET_ID, findWorkspacePreset, WORKSPACE_PRESETS } from "@/lib/sandbox-templates";
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
type RunDetail = { run: Doc<"agentRuns">; steps: Doc<"agentSteps">[]; events: Doc<"agentRunEvents">[]; artifacts: Doc<"agentArtifacts">[] };
type PendingApproval = Doc<"approvals"> & {
  taskTitle: string;
  runObjective: string | null;
  stepTitle: string | null;
  estimateLowRwf: bigint | null;
  estimateHighRwf: bigint | null;
};

const MAIN_BRANCH_ID = "main";

/**
 * A branch is one independently tracked coding run — the terminal can hold several at
 * once so a person can start another real task without losing the live status of the
 * one already in flight. "main" is the always-present branch for help/about/status and
 * simulated previews; it never carries a real run.
 */
type Branch = {
  id: string;
  label: string;
  isMain: boolean;
  runId: Id<"agentRuns"> | null;
  /** Live status of this branch's run, so its controls reflect what is actually true right now. */
  runStatus: Doc<"agentRuns">["status"] | null;
  track: TrackState | null;
  busy: boolean;
  log: LogEntry[];
};

/**
 * One-click shortcuts for a real run — each just submits the identical "run coding
 * <objective>" command a person would type. Every coding run currently starts from an empty
 * E2B workspace (no GitHub App is registered yet, so no repository is ever actually cloned in
 * — see docs/gap-register.md), so presets that imply pre-existing code ("write a test" for
 * what?, "lint check" of what?) would be misleading. These two sets keep the presets honest:
 * the from-scratch set is genuinely self-contained; the existing-codebase set only appears
 * once an organization has a real connected repository to act on. They're also the fallback
 * whenever the dynamic, model-generated presets below aren't configured or fail — the terminal
 * always has something sensible to show, real model call or not.
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

/** What the person is actually being asked to allow — never just the approval's id or kind. */
function approvalSummary(approval: PendingApproval): string {
  const subject = approval.stepTitle ?? approval.runObjective ?? approval.taskTitle;
  if (approval.kind === "task_start") {
    // The price is the whole point of this gate, so it leads — the objective follows it.
    const range = approval.estimateLowRwf !== null && approval.estimateHighRwf !== null
      ? `${formatRwf(Number(approval.estimateLowRwf))}–${formatRwf(Number(approval.estimateHighRwf))}`
      : "an estimated amount";
    const cap = approval.requestedRwf ? `, never above ${formatRwf(Number(approval.requestedRwf))}` : "";
    return `spend ${range}${cap} on "${subject}"`;
  }
  if (approval.kind === "budget_overage") {
    return approval.requestedRwf ? `raise the cap to ${formatRwf(Number(approval.requestedRwf))} for "${subject}"` : `raise the budget cap for "${subject}"`;
  }
  if (approval.kind === "external_action") return `run an external action for "${subject}"`;
  return `run "${subject}"`;
}

function branchLabel(objective: string): string {
  const trimmed = objective.trim();
  const words = trimmed.split(/\s+/).slice(0, 4).join(" ");
  return words.length < trimmed.length ? `${words}…` : words;
}

/**
 * Subscribes to one run's live Convex data and reports every snapshot up to its parent.
 * A dedicated component (not a loop of hooks in the parent) because each concurrent branch
 * needs its own independent useQuery subscription — the standard React shape for "N live
 * subscriptions" is N mounted components, not a dynamic hook count in one component.
 */
function BranchRunTracker({ runId, onSnapshot }: { runId: Id<"agentRuns">; onSnapshot: (detail: RunDetail) => void }) {
  const runDetail = useQuery(api.agentRuns.getRunDetail, { runId });
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  useEffect(() => {
    if (runDetail) onSnapshotRef.current(runDetail);
  }, [runDetail]);
  return null;
}

export type TerminalConsoleHandle = { resumeTask: (taskId: Id<"tasks">) => void };

export const TerminalConsole = forwardRef<TerminalConsoleHandle, object>(function TerminalConsole(_props, ref) {
  const [branches, setBranches] = useState<Branch[]>(() => [
    { id: MAIN_BRANCH_ID, label: "main", isMain: true, runId: null, runStatus: null, track: null, busy: false, log: [] },
  ]);
  const [activeBranchId, setActiveBranchId] = useState(MAIN_BRANCH_ID);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [scriptBusy, setScriptBusy] = useState(false);
  const [orbitFrame, setOrbitFrame] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [celebrationFrame, setCelebrationFrame] = useState(0);
  const [resumeTaskId, setResumeTaskId] = useState<Id<"tasks"> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scriptRunIdRef = useRef(0);
  const renderedEventIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const lastPresetContextKeyRef = useRef<string | null>(null);

  const [decidingApprovalId, setDecidingApprovalId] = useState<Id<"approvals"> | null>(null);
  const [controllingBranchId, setControllingBranchId] = useState<string | null>(null);
  const [workspacePresetId, setWorkspacePresetId] = useState<string>(DEFAULT_WORKSPACE_PRESET_ID);

  const session = authClient.useSession();
  const organization = useCurrentOrganization();
  const membership = useQuery(api.organizations.getCurrentMembership, session.data ? {} : "skip");
  // listPending fails closed for a role without approval:decide, so only subscribe when the
  // signed-in member can actually decide — a viewer sees no bar rather than a query error.
  const canDecideApprovals = membership ? hasPermission(membership.membership.role, "approval:decide") : false;
  const pendingApprovals = useQuery(api.approvals.listPending, organization && canDecideApprovals ? { organizationId: organization._id } : "skip");
  const decideApproval = useMutation(api.approvals.decide);
  const cancelRun = useMutation(api.agentRuns.requestCancellation);
  const pauseRunMutation = useMutation(api.agentRuns.pauseRun);
  const resumeRunMutation = useMutation(api.agentRuns.resumeRun);
  const startLiveRun = useAction(api.terminalRuns.startLiveCodingRun);
  const generateDynamicPresets = useAction(api.terminalPresetsActions.generate);
  const tasks = useQuery(api.tasks.listRecent, organization ? { organizationId: organization._id } : "skip");
  const githubInstallations = useQuery(api.githubModel.listForOrganization, organization ? { organizationId: organization._id } : "skip");
  const cachedDynamicPresets = useQuery(api.terminalPresets.getCached, organization ? { organizationId: organization._id } : "skip");
  const hasConnectedRepository = (githubInstallations ?? []).some((installation) => installation.status === "connected");
  const resumeRuns = useQuery(api.agentRuns.listForTask, resumeTaskId ? { taskId: resumeTaskId } : "skip");
  const [generatedPresets, setGeneratedPresets] = useState<{ label: string; objective: string }[] | null>(null);
  const staticPresets = hasConnectedRepository ? PRESETS_WITH_REPOSITORY : PRESETS_NO_REPOSITORY;
  const presets = generatedPresets ?? cachedDynamicPresets?.presets ?? staticPresets;

  useImperativeHandle(ref, () => ({ resumeTask: setResumeTaskId }), []);

  // Regenerates the model-suggested presets only when repo-connection state or recent task
  // history actually changes (a stable content hash, not a timer or every render) — real
  // model call happens server-side too, this just decides whether it's worth asking at all.
  useEffect(() => {
    if (!organization || !tasks) return;
    const contextKey = presetContextKey({ hasConnectedRepository, recentObjectives: tasks.slice(0, 5).map((task) => task.title) });
    if (lastPresetContextKeyRef.current === contextKey) return;
    lastPresetContextKeyRef.current = contextKey;
    generateDynamicPresets({ organizationId: organization._id })
      .then((result) => { if (result.presets) setGeneratedPresets(result.presets); })
      .catch(() => { /* the static/cached presets above already cover this — no user-facing error for a suggestion */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization, tasks, hasConnectedRepository]);

  const openApprovals: PendingApproval[] = pendingApprovals ?? [];
  const activeBranch = branches.find((branch) => branch.id === activeBranchId) ?? branches[0];
  const runningCount = branches.filter((branch) => branch.busy).length;
  const anyBusy = scriptBusy || runningCount > 0;
  const isGeneratedPresets = presets !== staticPresets;

  useEffect(() => {
    appendLineTo(MAIN_BRANCH_ID, { tone: "banner", text: buildBanner() });
    const timer = setTimeout(() => appendLineTo(MAIN_BRANCH_ID, { tone: "muted", text: 'Type "help" to see available commands. "run coding <objective>" is a real, billed agent run once you sign in above.' }), 260);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeBranch.log]);

  useEffect(() => {
    if (!anyBusy) return;
    const interval = setInterval(() => {
      setOrbitFrame((frame) => (frame + 1) % ORBIT_FRAMES.length);
      setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length);
    }, 140);
    return () => clearInterval(interval);
  }, [anyBusy]);

  // Plays a few celebration frames then settles, rather than animating forever.
  useEffect(() => {
    if (activeBranch.track?.outcome !== "completed") return;
    let cycles = 0;
    const interval = setInterval(() => {
      cycles += 1;
      setCelebrationFrame((frame) => (frame + 1) % CELEBRATION_FRAMES.length);
      if (cycles >= 5) clearInterval(interval);
    }, 260);
    return () => clearInterval(interval);
  }, [activeBranch.track?.outcome]);

  // Resuming a task from history: focus its branch if one is already open in this session,
  // otherwise open a new branch bound to its latest run and hand it the same live reactivity
  // path a fresh "run coding" already uses, so resumed status is exactly as real.
  useEffect(() => {
    if (!resumeTaskId || !resumeRuns) return;
    const latest = [...resumeRuns].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) {
      const existing = branches.find((branch) => branch.runId === latest._id);
      if (existing) {
        setActiveBranchId(existing.id);
        appendLineTo(existing.id, { tone: "system", text: `switched to "${latest.objective}" — showing its live status` });
      } else {
        const id = crypto.randomUUID();
        setBranches((current) => [
          ...current,
          {
            id,
            label: branchLabel(latest.objective),
            isMain: false,
            runId: latest._id,
            runStatus: latest.status,
            track: null,
            busy: true,
            log: [{ id: entryId(), tone: "system", text: `resuming "${latest.objective}" — loading live status…` }],
          },
        ]);
        setActiveBranchId(id);
      }
    } else {
      appendLineTo(activeBranchId, { tone: "warn", text: "that task has no run yet." });
    }
    setResumeTaskId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeTaskId, resumeRuns]);

  function appendLineTo(branchId: string, line: { tone: LogTone; text: string }) {
    setBranches((current) => current.map((branch) => (branch.id === branchId ? { ...branch, log: [...branch.log, { id: entryId(), ...line }] } : branch)));
  }

  function appendLine(line: { tone: LogTone; text: string }) {
    appendLineTo(activeBranchId, line);
  }

  function updateBranch(branchId: string, patch: Partial<Branch> | ((branch: Branch) => Partial<Branch>)) {
    setBranches((current) => current.map((branch) => (branch.id === branchId ? { ...branch, ...(typeof patch === "function" ? patch(branch) : patch) } : branch)));
  }

  function closeBranch(branchId: string) {
    setBranches((current) => current.filter((branch) => branch.id !== branchId));
    renderedEventIdsRef.current.delete(branchId);
    setActiveBranchId((current) => (current === branchId ? MAIN_BRANCH_ID : current));
  }

  /** Folds one live run snapshot into its branch — the same truthful mapping the terminal always used, now addressed by branch instead of a single global run. */
  function handleRunSnapshot(branchId: string, detail: RunDetail) {
    let seen = renderedEventIdsRef.current.get(branchId);
    if (!seen) {
      seen = new Set();
      renderedEventIdsRef.current.set(branchId, seen);
    }
    const newEvents = detail.events.filter((event) => !seen!.has(event._id));
    for (const event of newEvents) {
      seen!.add(event._id);
      appendLineTo(branchId, { tone: toneForEvent(event.type), text: `[${new Date(event.createdAt).toLocaleTimeString()}] ${event.message}` });
    }

    const stepByKey = new Map(detail.steps.map((step) => [step.stepKey, step]));
    const stages: Stage[] = stageKeysFor("coding").map((key) => {
      const step = stepByKey.get(key);
      return { key, label: key, status: step ? stageStatusFromStepStatus(step.status) : "pending" };
    });
    updateBranch(branchId, { runStatus: detail.run.status });
    const runTerminal = ["completed", "failed", "cancelled"].includes(detail.run.status);
    updateBranch(branchId, { track: { stages, outcome: runTerminal ? (detail.run.status === "completed" ? "completed" : "failed") : undefined } });

    if (newEvents.length === 0) return;
    if (runTerminal) {
      const task = tasks?.find((item) => item._id === detail.run.taskId);
      if (task) appendLineTo(branchId, { tone: detail.run.status === "completed" ? "success" : "error", text: `run ${detail.run.status} — spent ${formatRwf(Number(task.spentRwf))} of ${formatRwf(Number(task.maxRwf))} cap` });
      updateBranch(branchId, { busy: false });
    } else if (detail.run.status === "awaiting_approval") {
      // A run still sitting behind its own cost gate already printed its quote and the reason
      // it is waiting; repeating a generic "paused at an approval gate" line adds nothing.
      if (openApprovals.some((approval) => approval.runId === detail.run._id && approval.kind === "task_start")) {
        updateBranch(branchId, { busy: false });
        return;
      }
      appendLineTo(branchId, {
        tone: "warn",
        text: canDecideApprovals
          ? "run is paused at an approval gate — decide it in the approvals bar below to resume"
          : "run is paused at an approval gate — your role cannot decide approvals; ask an admin or owner of this workspace",
      });
      updateBranch(branchId, { busy: false });
    }
  }

  /**
   * Decides a real approval from the terminal. The decision is logged into the branch that is
   * tracking the affected run (not whichever branch happens to be focused), because that is the
   * branch whose live status is about to change — approvals.decide re-queues the run and kicks
   * the dispatcher, so the branch goes busy again on its own.
   */
  async function submitApprovalDecision(approval: PendingApproval, decision: "approved" | "rejected") {
    const branchId = branches.find((branch) => branch.runId === approval.runId)?.id ?? activeBranchId;
    setDecidingApprovalId(approval._id);
    appendLineTo(branchId, { tone: "input", text: `${decision === "approved" ? "approve" : "reject"} ${approvalSummary(approval)}` });
    try {
      await decideApproval({ approvalId: approval._id, decision });
      const isCostGate = approval.kind === "task_start";
      if (decision === "approved") {
        appendLineTo(branchId, { tone: "success", text: isCostGate ? "quote accepted — the budget is held and the run is starting" : "approved — the run is back in the dispatch queue and a tick was requested" });
        if (approval.runId) updateBranch(branchId, { busy: true, track: { stages: initialStages("coding") } });
      } else {
        appendLineTo(branchId, { tone: "warn", text: isCostGate ? "quote declined — nothing was charged and the task is cancelled" : "rejected — the task is blocked and no further work will run against it" });
        if (isCostGate) updateBranch(branchId, { busy: false, track: null });
      }
    } catch (error) {
      appendLineTo(branchId, { tone: "error", text: errorMessage(error) });
    } finally {
      setDecidingApprovalId(null);
    }
  }

  /**
   * Run controls act on the branch being watched, which is the run the person is actually looking
   * at. Each reports what happened in that branch's own log rather than a toast, so the record of
   * who stopped a run sits in the same timeline as the work it stopped.
   */
  async function controlRun(branch: Branch, action: "pause" | "resume" | "stop") {
    if (!branch.runId) return;
    setControllingBranchId(branch.id);
    try {
      if (action === "stop") {
        await cancelRun({ runId: branch.runId });
        appendLineTo(branch.id, { tone: "warn", text: "stop requested — the worker stops at its next safe checkpoint and the sandbox is released" });
        updateBranch(branch.id, { busy: false });
      } else if (action === "pause") {
        const result = await pauseRunMutation({ runId: branch.runId });
        appendLineTo(branch.id, {
          tone: "warn",
          text: result.stepInFlight
            ? "paused — the step already running will finish, then nothing further starts until you resume"
            : "paused — nothing further starts until you resume. The workspace is kept exactly as it is",
        });
        updateBranch(branch.id, { busy: false });
      } else {
        await resumeRunMutation({ runId: branch.runId });
        appendLineTo(branch.id, { tone: "success", text: "resumed — continuing in the same workspace" });
        updateBranch(branch.id, { busy: true });
      }
    } catch (error) {
      appendLineTo(branch.id, { tone: "error", text: errorMessage(error) });
    } finally {
      setControllingBranchId(null);
    }
  }

  async function playScript(lines: TerminalLine[], trackTaskKind?: TaskKind) {
    const branchId = activeBranchId;
    const myRunId = ++scriptRunIdRef.current;
    setScriptBusy(true);
    if (trackTaskKind) updateBranch(branchId, { track: { stages: initialStages(trackTaskKind) } });
    const stageCount = trackTaskKind ? stageKeysFor(trackTaskKind).length : 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      await delay(line.delayMs);
      if (scriptRunIdRef.current !== myRunId) return;
      appendLineTo(branchId, { tone: line.tone, text: line.text });
      if (trackTaskKind) {
        const reachedIndex = Math.min(stageCount - 1, Math.floor(((index + 1) / lines.length) * stageCount));
        updateBranch(branchId, (branch) => ({ track: branch.track && { stages: branch.track.stages.map((stage, i) => ({ ...stage, status: i < reachedIndex ? "completed" : i === reachedIndex ? "active" : "pending" })) } }));
      }
    }
    if (scriptRunIdRef.current !== myRunId) return;
    setScriptBusy(false);
    if (trackTaskKind) {
      // A settlement line (tone "success") only ever appears for a run that actually
      // finished; checking anywhere in the script (not just the last line) matters because
      // the script itself ends with a trailing "evidence recorded" note after settlement.
      const succeeded = lines.some((line) => line.tone === "success");
      if (succeeded) updateBranch(branchId, (branch) => ({ track: branch.track && { stages: branch.track.stages.map((stage) => ({ ...stage, status: "completed" })), outcome: "completed" } }));
      // Any other ending (e.g. an operations run paused at its approval gate) leaves the
      // track showing exactly how far it actually got — no fabricated completion.
    }
  }

  async function runLiveCoding(objective: string, raw: string) {
    if (!session.data) {
      appendLine({ tone: "input", text: raw });
      appendLine({ tone: "error", text: "sign in first (panel above) — a real run needs an authenticated workspace." });
      return;
    }
    if (!organization) {
      appendLine({ tone: "input", text: raw });
      appendLine({ tone: "warn", text: "your workspace is still being set up — try again in a moment." });
      return;
    }
    const branchId = crypto.randomUUID();
    setBranches((current) => [
      ...current,
      {
        id: branchId,
        label: branchLabel(objective),
        isMain: false,
        runId: null,
        runStatus: null,
        track: null,
        // Not busy yet: this only prices the work. Nothing runs until the quote is accepted.
        busy: false,
        log: [
          // The command echo lives in the branch it creates, not the branch that was active
          // when it was typed — a live browser test caught this landing in the wrong branch.
          { id: entryId(), tone: "input", text: raw },
          { id: entryId(), tone: "system", text: `pricing a real coding run — objective: "${objective}"` },
          { id: entryId(), tone: "muted", text: `workspace: ${findWorkspacePreset(workspacePresetId).label} — ${findWorkspacePreset(workspacePresetId).description}` },
          { id: entryId(), tone: "muted", text: "compiling the run graph and quoting it before anything is charged…" },
        ],
      },
    ]);
    setActiveBranchId(branchId);
    try {
      const result = await startLiveRun({ organizationId: organization._id, objective, idempotencyKey: crypto.randomUUID(), workspacePresetId });
      updateBranch(branchId, { runId: result.runId, busy: !result.awaitingCostApproval, track: result.awaitingCostApproval ? null : { stages: initialStages("coding") } });
      if (result.awaitingCostApproval) {
        appendLineTo(branchId, { tone: "system", text: `quote  ${formatRwf(result.quote.estimateLowRwf)} to ${formatRwf(result.quote.estimateHighRwf)}   ·   hard cap ${formatRwf(result.quote.maxRwf)}   ·   ${result.quote.confidence} confidence` });
        for (const assumption of result.quote.assumptions) appendLineTo(branchId, { tone: "muted", text: `  · ${assumption}` });
        appendLineTo(branchId, { tone: "warn", text: "nothing is charged and no worker has started — approve the quote below to run it, or reject to drop it" });
      }
    } catch (error) {
      appendLineTo(branchId, { tone: "error", text: errorMessage(error) });
      updateBranch(branchId, (branch) => ({ track: branch.track && { ...branch.track, outcome: "failed" }, busy: false }));
    }
  }

  function submit(raw: string) {
    if (raw.trim()) setHistory((current) => [...current, raw]);
    setHistoryIndex(null);

    const parsed = parseCommand(raw);
    if (parsed.kind === "empty") { appendLine({ tone: "input", text: raw || " " }); return; }
    // A real coding run opens its own branch, so its command echo belongs there, not in
    // whichever branch happened to be active when it was typed — runLiveCoding handles it.
    if (parsed.kind === "run" && parsed.taskKind === "coding") { void runLiveCoding(parsed.objective, raw); return; }

    appendLine({ tone: "input", text: raw });
    if (parsed.kind === "clear") { updateBranch(activeBranchId, { log: [] }); return; }
    if (parsed.kind === "help") { void playScript(buildHelpLines()); return; }
    if (parsed.kind === "about") { void playScript(buildAboutLines()); return; }
    if (parsed.kind === "status") { void playScript(buildStatusLines()); return; }
    if (parsed.kind === "unknown") { void playScript(buildUnknownCommandLines(parsed.raw)); return; }
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
      {branches
        .filter((branch): branch is Branch & { runId: Id<"agentRuns"> } => branch.runId !== null)
        .map((branch) => (
          <BranchRunTracker key={branch.runId} runId={branch.runId} onSnapshot={(detail) => handleRunSnapshot(branch.id, detail)} />
        ))}
      <div className="terminal-titlebar">
        <span className="terminal-dots" aria-hidden="true">
          <span className="terminal-dot terminal-dot-red" />
          <span className="terminal-dot terminal-dot-yellow" />
          <span className="terminal-dot terminal-dot-green" />
        </span>
        <span className="terminal-title">
          <span className="terminal-title-path">~/{session.data ? session.data.user.email.split("@")[0] : "guest"}</span>
          <span className="terminal-title-sep">/</span>
          <span className="terminal-title-branch">{activeBranch.label}</span>
        </span>
        <span className={`terminal-status${anyBusy ? " terminal-status-live" : ""}`}>
          {anyBusy ? <span className="terminal-orbit">{ORBIT_FRAMES[orbitFrame]}</span> : <span className="terminal-status-dot" />}
          {anyBusy ? `${runningCount} running` : "idle"}
        </span>
      </div>
      {branches.length > 1 && (
        <div className="terminal-branches">
          {branches.map((branch) => {
            const status = branch.busy ? "running" : branch.track?.outcome === "completed" ? "completed" : branch.track?.outcome === "failed" ? "failed" : "idle";
            return (
              <div key={branch.id} className={`terminal-branch-tab${branch.id === activeBranchId ? " terminal-branch-tab-active" : ""}`}>
                <button type="button" className="terminal-branch-select" onClick={() => setActiveBranchId(branch.id)}>
                  <span className={`terminal-branch-dot terminal-branch-dot-${status}`} />
                  {branch.label}
                </button>
                {!branch.isMain && !branch.busy && (
                  <button type="button" className="terminal-branch-close" aria-label={`Close ${branch.label}`} onClick={() => closeBranch(branch.id)}>
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {activeBranch.runId && activeBranch.runStatus && !["completed", "failed", "cancelled"].includes(activeBranch.runStatus) && (
        <div className="terminal-run-controls">
          <span className={`terminal-run-state terminal-run-state-${activeBranch.runStatus}`}>{activeBranch.runStatus.replaceAll("_", " ")}</span>
          {activeBranch.runStatus === "paused" ? (
            <button type="button" className="terminal-run-button terminal-run-resume" disabled={controllingBranchId === activeBranch.id} onClick={() => void controlRun(activeBranch, "resume")}>
              Resume
            </button>
          ) : (
            <button type="button" className="terminal-run-button" disabled={controllingBranchId === activeBranch.id || activeBranch.runStatus === "awaiting_approval"} onClick={() => void controlRun(activeBranch, "pause")}>
              Pause
            </button>
          )}
          <button type="button" className="terminal-run-button terminal-run-stop" disabled={controllingBranchId === activeBranch.id} onClick={() => void controlRun(activeBranch, "stop")}>
            Stop
          </button>
          {/* Says what the buttons actually do: neither one can interrupt a command already running. */}
          <span className="terminal-run-note">a step already running always finishes</span>
        </div>
      )}
      {activeBranch.track && (
        <div className={`terminal-track-panel${activeBranch.track.outcome ? ` terminal-track-${activeBranch.track.outcome}` : ""}`}>
          <pre className="terminal-track-art terminal-track-art-wide">{renderStageTrack(activeBranch.track.stages, SPINNER_FRAMES[spinnerFrame])}</pre>
          <pre className="terminal-track-art terminal-track-art-narrow">{renderStageTrackVertical(activeBranch.track.stages, SPINNER_FRAMES[spinnerFrame])}</pre>
          {activeBranch.track.outcome === "completed" && <pre className="terminal-celebration">{CELEBRATION_FRAMES[celebrationFrame]}</pre>}
          {activeBranch.track.outcome === "failed" && <pre className="terminal-celebration terminal-failure-art">{renderFailureBanner()}</pre>}
        </div>
      )}
      <div className="terminal-body">
        {activeBranch.log.map((entry) => (
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
        <div ref={logEndRef} />
      </div>
      {/* Pinned below the scrolling log: the things you act with shouldn't scroll away. */}
      <div className="terminal-dock">
        {/* Pending approvals sit above everything else in the dock: a run stays stopped until
            one of these is decided, so it is the most urgent thing the terminal can show. */}
        {openApprovals.length > 0 && (
          <div className="terminal-approvals" role="region" aria-label="Pending approvals">
            {openApprovals.map((approval) => (
              <div className="terminal-approval" key={approval._id}>
                <span className="terminal-approval-mark" aria-hidden="true">⚠</span>
                <span className="terminal-approval-text" title={approvalSummary(approval)}>
                  Approve to {approvalSummary(approval)}
                </span>
                <button type="button" className="terminal-approval-accept" disabled={decidingApprovalId === approval._id} onClick={() => void submitApprovalDecision(approval, "approved")}>
                  {decidingApprovalId === approval._id ? "…" : "Approve"}
                </button>
                <button type="button" className="terminal-approval-reject" disabled={decidingApprovalId === approval._id} onClick={() => void submitApprovalDecision(approval, "rejected")}>
                  Reject
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="terminal-workspace-row">
          <span className="terminal-workspace-label">Workspace</span>
          {WORKSPACE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              aria-pressed={workspacePresetId === preset.id}
              className={`terminal-workspace-option${workspacePresetId === preset.id ? " terminal-workspace-option-active" : ""}`}
              onClick={() => setWorkspacePresetId(preset.id)}
            >
              {preset.label}
            </button>
          ))}
          {/* The tools each image ships, so the choice is legible before a run rather than after one fails. */}
          <span className="terminal-workspace-tools">{findWorkspacePreset(workspacePresetId).programs.join(" · ")}</span>
        </div>
        <div className="terminal-presets">
          <span className="terminal-presets-label" title={isGeneratedPresets ? "Suggested for your workspace by a real model call" : "Starter tasks for an empty workspace"}>
            {isGeneratedPresets ? "◆" : "◇"}
          </span>
          {presets.map((preset) => (
            <button key={preset.label} type="button" className="terminal-preset-button" disabled={scriptBusy} title={preset.objective} onClick={() => submit(`run coding ${preset.objective}`)}>
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
            placeholder={scriptBusy ? "preview playing — you can still start a real run" : 'run coding <objective>   ·   help'}
            aria-label="Terminal command input"
          />
          <button type="submit" className="terminal-send" disabled={!input.trim()} aria-label="Run command">↵</button>
        </form>
      </div>
    </div>
  );
});
