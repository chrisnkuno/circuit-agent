import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Undo for an agent that edits real files.
 *
 * Both Cline and OpenCode converged on snapshotting the workspace around every effectful step, and
 * OpenCode's mechanism is the one used here: git's plumbing (`write-tree`/`read-tree`) against a
 * private index file. It is the right tool because the repository already stores content
 * efficiently, and because a snapshot costs one tree object rather than a copy of the workspace.
 *
 * The private index (`GIT_INDEX_FILE`) is what keeps this invisible: staging the workspace into
 * Nova's own index never touches the user's staged changes, so a checkpoint taken mid-review does
 * not silently `git add` their work.
 */

/**
 * Nova's own state is excluded from every snapshot.
 *
 * `.nova` holds the checkpoint index itself and the session transcripts, and it lives inside the
 * workspace. Staging it means git writes the index file into the tree it is currently building —
 * which corrupts it ("index file smaller than expected") — and restoring then deletes the session
 * history along with the code. Both were observed before this exclusion existed.
 */
const EXCLUDE_NOVA = [".", ":(exclude).nova"];

export type Checkpoint = {
  /** Tree object id — the workspace content at this moment. */
  tree: string;
  label: string;
  createdAt: number;
};

export type GitRunner = (args: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const runGit: GitRunner = (args, options) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ exitCode: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });

export class CheckpointStore {
  private readonly checkpoints: Checkpoint[] = [];

  constructor(
    private readonly root: string,
    private readonly indexFile: string,
    private readonly git: GitRunner = runGit,
  ) {}

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** True when this workspace is a git repository, which is the only place checkpoints work. */
  async isAvailable(): Promise<boolean> {
    const result = await this.git(["rev-parse", "--git-dir"], { cwd: this.root });
    return result.exitCode === 0;
  }

  /**
   * Snapshots the current workspace.
   *
   * Returns undefined rather than throwing when checkpointing is impossible (no repository, git
   * missing): losing undo is a reduction in comfort, and failing the user's task over it would be
   * a reduction in function.
   */
  async capture(label: string): Promise<Checkpoint | undefined> {
    // git cannot create its index inside a directory that does not exist, so on a brand-new
    // project the very first capture failed and the first turn silently had no undo — the one
    // turn where a user is most likely to want it.
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true }).catch(() => undefined);
    const env = { GIT_INDEX_FILE: this.indexFile };
    const added = await this.git(["add", "--all", "--", ...EXCLUDE_NOVA], { cwd: this.root, env });
    if (added.exitCode !== 0) return undefined;
    const tree = await this.git(["write-tree"], { cwd: this.root, env });
    if (tree.exitCode !== 0) return undefined;
    const checkpoint = { tree: tree.stdout.trim(), label, createdAt: Date.now() };
    if (!checkpoint.tree) return undefined;
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Restores the workspace to a checkpoint.
   *
   * `read-tree -u --reset` only removes files the index knows about, so the staging step is not
   * optional: without it, a file the agent *created* after the snapshot is untracked in Nova's
   * private index and survives the undo. That was the actual behaviour before this step existed —
   * modified files reverted, newly created ones stayed, and the workspace ended up in a state that
   * had never existed. Staging first makes every new file known, so `--reset` can remove it.
   */
  async restore(tree: string): Promise<boolean> {
    const env = { GIT_INDEX_FILE: this.indexFile };
    const staged = await this.git(["add", "--all", "--", ...EXCLUDE_NOVA], { cwd: this.root, env });
    if (staged.exitCode !== 0) return false;
    const result = await this.git(["read-tree", "-u", "--reset", tree], { cwd: this.root, env });
    return result.exitCode === 0;
  }

  /** The most recent checkpoint taken before the current step, for `/undo`. */
  latest(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }
}
