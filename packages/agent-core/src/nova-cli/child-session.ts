import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentTurnProvider } from "../agent-runtime";
import type { ModelPriceCatalog } from "../model-cost";
import { DEFAULT_NOVA_BUDGETS, NovaAgent, type NovaEvent, type NovaTurnResult } from "./agent";
import { LocalWorkspace } from "./backends";
import { runGit, type GitRunner } from "./checkpoints";
import type { DaemonApprovalRequest, NovaDaemonClient, NovaSessionDaemon } from "./daemon";
import { capabilitiesForMode, type NovaMode, type PermissionDecision } from "./permissions";

/**
 * A parent agent delegating bounded work to a child, without either becoming a hazard to the other.
 *
 * Three properties define "attenuated," and each is enforced by a different mechanism because each
 * fails a different way if it isn't:
 *
 * - **Capabilities** a child gets can never exceed what its parent already has. Checked once, at
 *   spawn, against the same mode→capability table the runtime already uses — there is no second,
 *   parallel notion of what a mode is allowed to do.
 * - **Budget** a child spends is reserved from the parent's own remaining pool up front, and never
 *   refilled. Three children racing for the same 1000 RWF cannot collectively spend 3000 — the
 *   third to ask simply cannot reserve what is no longer there.
 * - **Files** a child touches live in their own git worktree, not the parent's working directory.
 *   This is the concrete fix for a real collision: two agents editing the same file at the same
 *   time in one directory silently overwrite each other, exactly as happened when a second agent
 *   started rewriting a file this session had uncommitted changes in. A worktree makes that
 *   structurally impossible rather than a matter of coordinating carefully.
 *
 * A child is still a full session through `NovaSessionDaemon` — same journal, same approval
 * digests, same everything the parent gets. Nothing here is a smaller copy of the runtime; it is a
 * narrower grant of what an ordinary session can already do.
 */

// ---------------------------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------------------------

export type ChildMessage = { at: number; body: unknown };

/**
 * Coordination messages between a parent and its children, kept apart from the agent event stream.
 *
 * The event stream is what an agent *did* — tool calls, results, turn status — and every consumer
 * of it needs all of it. A mailbox message is different in kind: "stop, I found the answer
 * already," "here is the file path I need you to write to." Mixing the two would force every event
 * consumer to filter out messages meant for one specific child, and would force a message to wait
 * behind however much event traffic preceded it.
 *
 * FIFO per direction per child. A message is removed from its queue the moment it is drained, so
 * two readers of the same inbox never see the same message twice — there is exactly one reader on
 * each side of a mailbox, and this makes accidentally attaching a second one immediately obvious
 * rather than silently splitting the stream.
 */
export class ChildMailbox {
  private readonly toChild = new Map<string, ChildMessage[]>();
  private readonly toParent = new Map<string, ChildMessage[]>();

  postToChild(childId: string, body: unknown): void {
    const queue = this.toChild.get(childId) ?? [];
    queue.push({ at: Date.now(), body });
    this.toChild.set(childId, queue);
  }

  postToParent(childId: string, body: unknown): void {
    const queue = this.toParent.get(childId) ?? [];
    queue.push({ at: Date.now(), body });
    this.toParent.set(childId, queue);
  }

  /** Everything waiting for this child, oldest first, and removed from the queue by reading it. */
  drainToChild(childId: string): ChildMessage[] {
    const queue = this.toChild.get(childId) ?? [];
    this.toChild.set(childId, []);
    return queue;
  }

  drainToParent(childId: string): ChildMessage[] {
    const queue = this.toParent.get(childId) ?? [];
    this.toParent.set(childId, []);
    return queue;
  }

  /** Drops both queues for a child — called once it is finished, so a stale message cannot leak. */
  forget(childId: string): void {
    this.toChild.delete(childId);
    this.toParent.delete(childId);
  }
}

// ---------------------------------------------------------------------------------------------
// Budget attenuation
// ---------------------------------------------------------------------------------------------

export class ChildBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildBudgetError";
  }
}

/**
 * A parent's remaining spend, divided among children by reservation rather than by trust.
 *
 * Reservation happens at spawn, before the child can place a single model call, and is subtracted
 * from the pool immediately — not metered as the child spends. That is what makes "three children
 * cannot collectively outspend the parent" true by construction instead of by every child
 * behaving: the fourth reservation simply does not fit, regardless of what the first three
 * actually go on to spend.
 *
 * `settle` returns the unspent remainder once a child finishes, so a child that reserved 500 RWF
 * and spent 120 gives the other 380 back to the pool rather than burning it on a ceiling nobody
 * hit.
 */
export class ChildBudgetPool {
  private remaining: number;
  private readonly reservations = new Map<string, number>();

  constructor(totalRwf: number) {
    if (!Number.isSafeInteger(totalRwf) || totalRwf < 0) throw new ChildBudgetError("Pool total must be a non-negative integer");
    this.remaining = totalRwf;
  }

  get remainingRwf(): number {
    return this.remaining;
  }

  reserve(childId: string, amountRwf: number): void {
    if (!Number.isSafeInteger(amountRwf) || amountRwf <= 0) throw new ChildBudgetError(`${childId}: reservation must be a positive integer`);
    if (this.reservations.has(childId)) throw new ChildBudgetError(`${childId} already has a reservation`);
    if (amountRwf > this.remaining) {
      throw new ChildBudgetError(`${childId} asked for ${amountRwf} RWF but only ${this.remaining} remains in the pool`);
    }
    this.remaining -= amountRwf;
    this.reservations.set(childId, amountRwf);
  }

  /** Refunds whatever a reservation was not actually spent. Idempotent per child: settles once. */
  settle(childId: string, actualSpentRwf: number): number {
    const reserved = this.reservations.get(childId);
    if (reserved === undefined) throw new ChildBudgetError(`${childId} has no reservation to settle`);
    this.reservations.delete(childId);
    const spent = Math.max(0, Math.min(actualSpentRwf, reserved));
    const refund = reserved - spent;
    this.remaining += refund;
    return refund;
  }
}

// ---------------------------------------------------------------------------------------------
// Capability attenuation
// ---------------------------------------------------------------------------------------------

/**
 * Refuses a child mode that would grant a capability its parent's mode does not have.
 *
 * Reuses `capabilitiesForMode` rather than a second table: `plan` and `build`/`auto` already define
 * exactly what each mode may do, and a child's grant is checked against that same definition. Build
 * and auto carry the identical capability set (they differ only in which of those capabilities ask
 * for approval before running) so either may parent the other; plan may not parent either, since
 * both add write and terminal access plan does not have.
 */
export function assertAttenuatedMode(parentMode: NovaMode, childMode: NovaMode): void {
  const parentCapabilities = new Set(capabilitiesForMode(parentMode));
  const excess = capabilitiesForMode(childMode).filter((id) => !parentCapabilities.has(id));
  if (excess.length > 0) {
    throw new Error(`Child mode "${childMode}" would grant ${excess.join(", ")}, which parent mode "${parentMode}" does not have`);
  }
}

// ---------------------------------------------------------------------------------------------
// Isolated worktrees
// ---------------------------------------------------------------------------------------------

export type ChildWorktree = { path: string; branch: string };

/**
 * A real `git worktree` for one child — a second checkout of the same repository, sharing its
 * history but with files a sibling or the parent cannot see change underneath them.
 *
 * This is not a private git index the way `CheckpointStore` uses one (a snapshot mechanism with no
 * real files on disk); a worktree is an actual directory a `LocalWorkspace` can point at, which is
 * the property a concurrent child needs — its edits must be visible to its own tools without being
 * visible to anyone else's until they are deliberately merged back.
 */
export async function createChildWorktree(root: string, childId: string, git: GitRunner = runGit): Promise<ChildWorktree> {
  const branch = `nova-child/${childId}`;
  const worktreePath = path.join(root, ".nova", "children", childId);
  const result = await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(`Could not create an isolated worktree for ${childId}: ${(result.stderr || result.stdout).trim()}`);
  }
  return { path: worktreePath, branch };
}

/** Removes a child's worktree and its branch. Best-effort on the branch: a merged one may differ. */
export async function removeChildWorktree(root: string, worktree: ChildWorktree, git: GitRunner = runGit): Promise<void> {
  const result = await git(["worktree", "remove", "--force", worktree.path], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`Could not remove worktree ${worktree.path}: ${(result.stderr || result.stdout).trim()}`);
  await git(["branch", "-D", worktree.branch], { cwd: root }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Spawning and lifecycle
// ---------------------------------------------------------------------------------------------

export type SpawnChildOptions = {
  daemon: NovaSessionDaemon;
  parentSessionId: string;
  parentMode: NovaMode;
  /** Repository root the parent itself works in; the child's worktree is created inside it. */
  root: string;
  /**
   * The parent's own remaining spend, used only the first time a pool is created for this parent.
   * Later spawns for the same parent reuse the existing pool and its current balance — passing a
   * different number here on a later call does not top it back up.
   */
  parentRemainingRwf: number;
  maxRwf: number;
  /** Defaults to "auto" — a child has no terminal, so it needs pre-approval to get anything done. */
  mode?: NovaMode;
  model: AgentTurnProvider;
  prices: ModelPriceCatalog;
  /** False only for a caller that has already decided isolation is unnecessary (e.g. a read-only child). */
  worktree?: boolean;
  git?: GitRunner;
  onEvent?: (event: NovaEvent) => void;
  /**
   * Answers whatever "auto" mode's own fast path does not pre-approve — a sensitive workspace
   * change, or anything with an external effect. There is no terminal attached to a child, so the
   * default is deny: the same fail-closed answer a human-facing prompt gives when stdin is not a
   * TTY. A parent that wants its children to escalate through it can wire this to `mailbox`
   * instead of overriding it with a blanket allow.
   */
  approve?: (request: DaemonApprovalRequest) => PermissionDecision | Promise<PermissionDecision>;
};

export type ChildSession = {
  id: string;
  parentSessionId: string;
  client: NovaDaemonClient;
  worktree?: ChildWorktree;
  root: string;
  spentRwf: number;
};

/**
 * Tracks every live child across every parent in this process, so a parent's own teardown can find
 * and cancel or dispose all of them without the caller having to remember which it spawned.
 */
export class ChildSessionRegistry {
  readonly mailbox = new ChildMailbox();
  private readonly pools = new Map<string, ChildBudgetPool>();
  private readonly childrenOf = new Map<string, Set<string>>();
  private readonly sessions = new Map<string, ChildSession>();

  poolFor(parentSessionId: string, parentRemainingRwf: number): ChildBudgetPool {
    let pool = this.pools.get(parentSessionId);
    if (!pool) {
      pool = new ChildBudgetPool(parentRemainingRwf);
      this.pools.set(parentSessionId, pool);
    }
    return pool;
  }

  async spawn(options: SpawnChildOptions): Promise<ChildSession> {
    // Unattended by default: a child has no terminal to answer a build-mode prompt, so ordinary
    // workspace edits need auto mode's own pre-approval to proceed at all. A caller that wants a
    // child gated exactly like an interactive build session can still pass `mode: "build"`
    // explicitly, together with its own `approve` policy.
    const childMode = options.mode ?? "auto";
    assertAttenuatedMode(options.parentMode, childMode);
    const childId = `child_${randomUUID()}`;
    const pool = this.poolFor(options.parentSessionId, options.parentRemainingRwf);
    // Reserved before anything else touches the filesystem or the daemon: a worktree created for a
    // reservation that then fails to register would leak a directory nobody owns.
    pool.reserve(childId, options.maxRwf);

    let worktree: ChildWorktree | undefined;
    let workingRoot = options.root;
    try {
      if (options.worktree !== false) {
        worktree = await createChildWorktree(options.root, childId, options.git);
        workingRoot = worktree.path;
      }
      const client = options.daemon.connect({
        id: childId,
        onNotification: (notification) => {
          if (notification.type === "agent_event") options.onEvent?.(notification.event);
        },
        approve: options.approve ?? (() => "deny"),
      });
      await client.open(({ onEvent, approve }) => new NovaAgent({
        root: workingRoot,
        model: options.model,
        prices: options.prices,
        mode: childMode,
        workspace: new LocalWorkspace(workingRoot),
        approve,
        onEvent,
        budgets: { ...DEFAULT_NOVA_BUDGETS, maxRwf: options.maxRwf },
      }));

      const session: ChildSession = { id: childId, parentSessionId: options.parentSessionId, client, worktree, root: options.root, spentRwf: 0 };
      this.sessions.set(childId, session);
      const siblings = this.childrenOf.get(options.parentSessionId) ?? new Set<string>();
      siblings.add(childId);
      this.childrenOf.set(options.parentSessionId, siblings);
      return session;
    } catch (error) {
      // The reservation and any worktree already created must not outlive a spawn that failed
      // partway through, or a retried spawn slowly starves the pool and litters the filesystem.
      pool.settle(childId, 0);
      if (worktree) await removeChildWorktree(options.root, worktree, options.git).catch(() => undefined);
      throw error;
    }
  }

  /** Runs one turn on a child and accumulates its real cost against the reservation it holds. */
  async send(childId: string, objective: string): Promise<NovaTurnResult> {
    const session = this.requireSession(childId);
    const result = await session.client.send(objective);
    session.spentRwf += result.actualModelRwf;
    return result;
  }

  cancel(childId: string): void {
    this.requireSession(childId).client.cancel();
  }

  /** Cancels every live child of a parent — the first half of tearing a parent down cleanly. */
  cancelAll(parentSessionId: string): void {
    for (const childId of this.childrenOf.get(parentSessionId) ?? []) {
      this.sessions.get(childId)?.client.cancel();
    }
  }

  /** Settles the child's spend, disposes its daemon client, and removes its worktree. */
  async finish(childId: string): Promise<void> {
    const session = this.requireSession(childId);
    const pool = this.pools.get(session.parentSessionId);
    pool?.settle(childId, session.spentRwf);
    await session.client.dispose();
    if (session.worktree) await removeChildWorktree(session.root, session.worktree).catch(() => undefined);
    this.mailbox.forget(childId);
    this.sessions.delete(childId);
    this.childrenOf.get(session.parentSessionId)?.delete(childId);
  }

  /** Finishes every live child of a parent — called when the parent itself is torn down. */
  async disposeAll(parentSessionId: string): Promise<void> {
    for (const childId of [...(this.childrenOf.get(parentSessionId) ?? [])]) {
      await this.finish(childId).catch(() => undefined);
    }
    this.pools.delete(parentSessionId);
    this.childrenOf.delete(parentSessionId);
  }

  private requireSession(childId: string): ChildSession {
    const session = this.sessions.get(childId);
    if (!session) throw new Error(`No live child session: ${childId}`);
    return session;
  }
}
