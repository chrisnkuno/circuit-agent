/**
 * Lifecycle management for local development servers Nova starts on a user's behalf.
 * A preview is reported only after HTTP readiness, remains alive across turns, and is torn down
 * with the workspace so a completed CLI session cannot leak background process trees.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { sanitizeCommandEnvironment } from "./command";

const MAX_LOG_BYTES = 128 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 20_000;

export type ApplicationStatus = {
  id: string;
  command: string;
  directory: string;
  port: number;
  url: string;
  state: "starting" | "running" | "exited";
  startedAt: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
};

export type StartApplicationRequest = {
  command: string;
  port: number;
  directory?: string;
  path?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type ApplicationProcess = ChildProcessByStdio<null, Readable, Readable>;
type ManagedApplication = ApplicationStatus & { process: ApplicationProcess };

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return Buffer.byteLength(next) <= MAX_LOG_BYTES
    ? next
    : Buffer.from(next).subarray(Buffer.byteLength(next) - MAX_LOG_BYTES).toString("utf8");
}

function terminateProcessTree(child: ApplicationProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // The process may have exited between the status check and the signal.
  }
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function httpIsReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 750 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.once("timeout", () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keeps user-requested local preview servers alive across model turns. */
export class LocalApplicationSupervisor {
  private readonly applications = new Map<string, ManagedApplication>();
  private nextId = 1;

  constructor(private readonly root: string) {}

  async start(request: StartApplicationRequest): Promise<ApplicationStatus> {
    if (!request.command.trim()) throw new Error("command must be a non-empty string");
    if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) throw new Error("port must be an integer between 1 and 65535");
    if (this.list().some((application) => application.state !== "exited" && application.port === request.port)) {
      throw new Error(`Nova already has an application on port ${request.port}. Stop it before starting another one.`);
    }
    if (await portIsOpen(request.port)) throw new Error(`Port ${request.port} is already in use by another process.`);

    const relativeDirectory = request.directory?.trim() || ".";
    const directory = path.resolve(this.root, relativeDirectory);
    const relative = path.relative(path.resolve(this.root), directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("directory must stay inside the project workspace");
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Application directory does not exist: ${relativeDirectory}`);

    const route = request.path?.trim() || "/";
    if (!route.startsWith("/") || route.startsWith("//")) throw new Error("path must begin with one slash");
    const url = `http://127.0.0.1:${request.port}${route}`;
    const id = `app-${this.nextId++}`;
    const child = spawn(request.command, [], {
      cwd: directory,
      shell: true,
      detached: process.platform !== "win32",
      env: sanitizeCommandEnvironment(process.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const application: ManagedApplication = {
      id,
      command: request.command,
      directory: relativeDirectory,
      port: request.port,
      url,
      state: "starting",
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      process: child,
    };
    this.applications.set(id, application);
    child.stdout.on("data", (chunk) => { application.stdout = appendBounded(application.stdout, chunk); });
    child.stderr.on("data", (chunk) => { application.stderr = appendBounded(application.stderr, chunk); });
    child.once("error", (error) => {
      application.stderr = appendBounded(application.stderr, error.message);
      application.state = "exited";
      application.exitCode = 127;
    });
    child.once("close", (code) => {
      application.state = "exited";
      application.exitCode = code ?? application.exitCode ?? 1;
    });

    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 1_000), 60_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (request.signal?.aborted) {
        await this.stop(id);
        throw new Error("Application start was cancelled.");
      }
      if (application.state === "exited") {
        throw new Error(this.failureMessage(application, `Application exited before port ${request.port} became ready.`));
      }
      if (await httpIsReady(url)) {
        application.state = "running";
        return this.snapshot(application);
      }
      await wait(150);
    }

    await this.stop(id);
    throw new Error(this.failureMessage(application, `Application did not answer HTTP at ${url} within ${timeoutMs}ms and was stopped.`));
  }

  list(): ApplicationStatus[] {
    return [...this.applications.values()].map((application) => this.snapshot(application));
  }

  get(id?: string): ApplicationStatus[] {
    if (!id) return this.list();
    const application = this.applications.get(id);
    return application ? [this.snapshot(application)] : [];
  }

  async stop(id: string): Promise<ApplicationStatus> {
    const application = this.applications.get(id);
    if (!application) throw new Error(`Unknown application: ${id}`);
    if (application.state !== "exited") {
      terminateProcessTree(application.process);
      await Promise.race([
        new Promise<void>((resolve) => application.process.once("close", () => resolve())),
        wait(1_000).then(() => {
          if (application.state !== "exited" && application.process.pid && process.platform !== "win32") {
            try { process.kill(-application.process.pid, "SIGKILL"); } catch {
              // It exited after the state check; the desired stopped state is already true.
            }
          }
        }),
      ]);
      application.state = "exited";
    }
    return this.snapshot(application);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.applications.values()].filter((application) => application.state !== "exited").map((application) => this.stop(application.id)));
  }

  private snapshot(application: ManagedApplication): ApplicationStatus {
    const { process: _process, ...status } = application;
    return { ...status };
  }

  private failureMessage(application: ManagedApplication, message: string): string {
    const logs = [application.stdout.trim(), application.stderr.trim()].filter(Boolean).join("\n");
    return logs ? `${message}\n\nRecent logs:\n${logs}` : `${message}\n\nThe process produced no logs.`;
  }
}
