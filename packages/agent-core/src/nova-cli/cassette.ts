import { createHash } from "node:crypto";
import type { AgentModelRequest, AgentModelTurn, AgentMessage, AgentTurnProvider } from "../agent-runtime";

/**
 * Recording a real model session so it can be run again without the model.
 *
 * The agent loop is deterministic; the model is not, and it is also slow, metered and offline half
 * the time. That single boundary is what stops the whole system being testable, so it is the one
 * this records. A cassette turns a real session into a fixture: the same tool calls, the same
 * refusals, the same token accounting, replayed byte for byte at no cost.
 *
 * The design decision that matters is that **replay verifies what it is answering**. A cassette
 * that hands back turn 3 whenever it is asked a third question is a test that passes while the
 * thing it tests has changed underneath it — the prompt was edited, a tool was renamed, the
 * history was compacted differently, and the recording answers anyway. Each entry therefore stores
 * a digest of the request it was recorded for, and a mismatch is a loud failure that names what
 * moved, not a silent wrong answer.
 *
 * A cassette holds the full conversation: prompts, file contents, command output. It is exactly as
 * sensitive as the session it recorded, and nothing here redacts it — redaction would change the
 * bytes that replay exists to reproduce. Treat a cassette like a transcript, because it is one.
 */

export const CASSETTE_VERSION = 1 as const;

export type CassetteEntry = {
  index: number;
  /** Digest of the request this turn was the answer to. */
  requestDigest: string;
  turn: AgentModelTurn;
};

export type Cassette = {
  cassette: typeof CASSETTE_VERSION;
  model: string;
  /** Informational only, and never part of any comparison, so re-recording is a clean diff. */
  recordedAt?: string;
  entries: CassetteEntry[];
};

/**
 * A stable fingerprint of everything that should determine the model's answer.
 *
 * Covers the messages and the tool surface, because those are the inputs a turn is a function of.
 * Deliberately excludes `maxOutputTokens` and `safetyIdentifier`: the first shifts with the budget
 * remaining and the second embeds a session id, so including either would make every cassette
 * single-use while neither changes what the model was actually asked.
 */
export function requestDigest(request: Pick<AgentModelRequest, "messages" | "tools">): string {
  const shape = {
    messages: request.messages.map(normalizeMessage),
    tools: [...request.tools].map((tool) => tool.name).sort(),
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function normalizeMessage(message: AgentMessage): unknown {
  if (message.role === "tool") return { role: "tool", name: message.name, content: message.content };
  if (message.role === "assistant" && "toolCalls" in message) {
    return {
      role: "assistant",
      content: message.content,
      // Tool-call ids are generated per run and carry no meaning across recordings; the name and
      // arguments are the part that says what the assistant actually decided to do.
      toolCalls: message.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments ?? {} })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Wraps a real provider, keeping every exchange. The wrapped provider's behaviour is unchanged. */
export class RecordingTurnProvider implements AgentTurnProvider {
  private readonly entries: CassetteEntry[] = [];
  private model = "";

  constructor(private readonly inner: AgentTurnProvider) {}

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    const digest = requestDigest(request);
    const turn = await this.inner.complete(request);
    this.model = turn.model || this.model;
    this.entries.push({ index: this.entries.length, requestDigest: digest, turn });
    return turn;
  }

  cassette(recordedAt?: string): Cassette {
    return {
      cassette: CASSETTE_VERSION,
      model: this.model,
      ...(recordedAt ? { recordedAt } : {}),
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }
}

export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CassetteError";
  }
}

export type ReplayOptions = {
  /**
   * Whether a request that does not match the recording is an error.
   *
   * On by default, and it should stay on: the failure it prevents is a test that keeps passing
   * after the behaviour under test has changed. Turning it off is for exploring an old cassette
   * against new code, not for making a red test green.
   */
  strict?: boolean;
};

/**
 * Replays a cassette in order, checking each request against what was recorded.
 *
 * Running past the end is an error rather than a hang or an undefined turn: a run that asks for
 * more turns than were recorded has diverged, and that is exactly as interesting as a mismatch.
 */
export class ReplayTurnProvider implements AgentTurnProvider {
  private position = 0;

  constructor(private readonly tape: Cassette, private readonly options: ReplayOptions = {}) {
    if (tape.cassette !== CASSETTE_VERSION) {
      throw new CassetteError(`Cassette version ${tape.cassette} cannot be replayed by version ${CASSETTE_VERSION}`);
    }
  }

  get remaining(): number {
    return this.tape.entries.length - this.position;
  }

  /** True once every recorded turn has been consumed — a run that stopped early is a divergence. */
  get exhausted(): boolean {
    return this.remaining === 0;
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    const entry = this.tape.entries[this.position];
    if (!entry) {
      throw new CassetteError(
        `The run asked for turn ${this.position + 1}, but the cassette holds ${this.tape.entries.length}. The agent made more model calls than were recorded.`,
      );
    }
    if (this.options.strict !== false) {
      const digest = requestDigest(request);
      if (digest !== entry.requestDigest) {
        throw new CassetteError(
          `Turn ${this.position + 1} does not match the recording: expected request ${entry.requestDigest.slice(0, 12)}, got ${digest.slice(0, 12)}. ` +
          `The prompt, tools or conversation changed since this cassette was recorded — re-record it if the change was intended.`,
        );
      }
    }
    this.position += 1;
    return entry.turn;
  }
}

export type Fault =
  /** The provider throws — a network drop, a 500, a timeout. */
  | { at: number; kind: "throw"; message: string }
  /** The provider answers, but with something the runtime must reject rather than trust. */
  | { at: number; kind: "malformed" }
  | { at: number; kind: "refusal"; refusal: string };

/**
 * Injects failures into an otherwise working provider, at a chosen turn.
 *
 * Error paths are the least-exercised and worst-tested part of any agent, because reproducing them
 * against a real provider means waiting for a real outage. The interesting question is not whether
 * the loop handles a happy path — it is whether a provider that dies on turn 4 of a run that has
 * already edited three files leaves the workspace, the ledger and the session in a state a person
 * can act on. This makes that a test rather than an incident.
 *
 * Turns are numbered from 1, matching the runtime's own iteration numbering and the cassette's
 * error messages, because an off-by-one between a fixture and the thing it describes is its own
 * afternoon.
 */
export class FaultInjectingTurnProvider implements AgentTurnProvider {
  private call = 0;

  constructor(private readonly inner: AgentTurnProvider, private readonly faults: readonly Fault[]) {}

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    this.call += 1;
    const fault = this.faults.find((candidate) => candidate.at === this.call);
    if (!fault) return this.inner.complete(request);
    if (fault.kind === "throw") throw new Error(fault.message);

    const turn = await this.inner.complete(request);
    if (fault.kind === "refusal") return { ...turn, finishReason: "refusal", refusal: fault.refusal, toolCalls: [] };
    // Claims tool calls and provides none — the shape a runtime must not follow into a loop.
    return { ...turn, finishReason: "tool_calls", toolCalls: [] };
  }
}

/** Parses and validates a cassette, so a malformed fixture fails at load with a clear reason. */
export function parseCassette(text: string): Cassette {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CassetteError(`Cassette is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CassetteError("Cassette must be a JSON object");
  const tape = value as Partial<Cassette>;
  if (tape.cassette !== CASSETTE_VERSION) throw new CassetteError(`Unsupported cassette version ${String(tape.cassette)}`);
  if (!Array.isArray(tape.entries)) throw new CassetteError("Cassette has no entries");
  tape.entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") throw new CassetteError(`Cassette entry ${index} is not an object`);
    if (typeof entry.requestDigest !== "string" || !entry.requestDigest) throw new CassetteError(`Cassette entry ${index} has no request digest`);
    if (!entry.turn || typeof entry.turn !== "object") throw new CassetteError(`Cassette entry ${index} has no turn`);
    // Order is the contract; an out-of-order tape would replay answers against the wrong requests.
    if (entry.index !== index) throw new CassetteError(`Cassette entry ${index} is out of order`);
  });
  return { cassette: CASSETTE_VERSION, model: typeof tape.model === "string" ? tape.model : "", recordedAt: tape.recordedAt, entries: tape.entries };
}

/** Serializes deterministically, so re-recording an unchanged session produces an identical file. */
export function serializeCassette(tape: Cassette): string {
  return `${JSON.stringify(tape, null, 2)}\n`;
}
