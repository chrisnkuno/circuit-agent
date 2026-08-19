import { AcpConnection, type AcpSession, type JsonRpcOutgoing } from "@circuit-nova/nova-core/nova-cli/acp";
import { NovaAgent } from "@circuit-nova/nova-core/nova-cli/agent";
import { LocalWorkspace } from "@circuit-nova/nova-core/nova-cli/backends";
import type { NovaMode } from "@circuit-nova/nova-core/nova-cli/permissions";
import { loadSession } from "@circuit-nova/nova-core/nova-cli/session";
import { resolveProvider } from "@circuit-nova/nova-core/providers/agent-matrix";
import { createExaClient } from "@circuit-nova/nova-core/providers/exa";

/**
 * `nova acp` — the same agent, driven by an editor over stdio.
 *
 * Nothing about a Nova session is terminal-shaped underneath: a turn already emits structured
 * events and already pauses on an approval that somebody else answers. What the terminal front end
 * adds is rendering and a human. ACP replaces both with an editor, and this file is only the
 * plumbing that lets it — framing on the wire, a session factory, and the mapping from Nova's
 * approval decisions to the option list a client shows.
 *
 * Line-delimited JSON, one complete message per line, in both directions. Nothing else may ever be
 * written to stdout while this is running: a stray banner or a progress spinner is a parse error at
 * the other end, and the client has no way to resynchronize. Diagnostics go to stderr.
 */

/**
 * Splits a stdio chunk into complete messages, keeping whatever is left over.
 *
 * Pure and separate from the stream because this is where a naive implementation breaks in
 * production and nowhere else: a large `session/prompt` arrives in several chunks, and a reader
 * that assumes one chunk is one message loses the tail of every big paste. Blank lines are skipped
 * rather than treated as empty messages, which is what a client that pretty-prints its framing
 * produces.
 */
export function splitFrames(buffer: string): { messages: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { messages: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest };
}

export type AcpServerOptions = {
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  environment: Record<string, string | undefined>;
  defaultRoot: string;
  /** Human-readable diagnostics, never on the protocol channel. */
  warn?: (message: string) => void;
  mode?: NovaMode;
};

/** One `nova acp` process: reads until stdin closes, then disposes every live session. */
export async function runAcpServer(options: AcpServerOptions): Promise<number> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const send = (message: JsonRpcOutgoing) => options.write(`${JSON.stringify(message)}\n`);

  const connection = new AcpConnection({
    send,
    createSession: async ({ cwd, onEvent, approve, resumeSessionId }): Promise<AcpSession> => {
      const resolved = resolveProvider(options.environment, {});
      if ("error" in resolved) throw new Error(resolved.error);
      const root = cwd || options.defaultRoot;

      // A mode change rebuilds the agent under the new capability set and carries the transcript
      // across, exactly as `/mode` does in the terminal. Anything less would be a lie: plan mode is
      // a mode in which the write tools are not loaded, and that is decided when the tools are built.
      let mode: NovaMode = options.mode ?? "build";
      let agent = build(mode);

      function build(currentMode: NovaMode): NovaAgent {
        return new NovaAgent({
          root,
          model: (resolved as Exclude<typeof resolved, { error: string }>).provider,
          prices: priceCatalogFor((resolved as Exclude<typeof resolved, { error: string }>).prices),
          mode: currentMode,
          workspace: new LocalWorkspace(root),
          search: createExaClient(options.environment),
          onEvent,
          approve: async (request) =>
            approve({ toolName: request.tool.name, summary: request.summary, toolCallId: request.call.id }),
        });
      }

      if (resumeSessionId) {
        const record = await loadSession(root, resumeSessionId);
        if (!record) throw new Error(`No stored session ${resumeSessionId} in ${root}`);
        agent.resume(record);
      }

      return {
        get id() { return agent.sessionId; },
        send: (prompt) => agent.send(prompt),
        cancel: () => agent.cancel(),
        async setMode(next) {
          if (next === mode) return;
          const carried = await loadSession(root, agent.sessionId);
          await agent.relinquish();
          mode = next;
          agent = build(next);
          if (carried) agent.resume(carried);
        },
        dispose: () => agent.dispose(),
      };
    },
  });

  let buffer = "";
  options.input.setEncoding?.("utf8");
  try {
    for await (const chunk of options.input as AsyncIterable<string>) {
      buffer += chunk;
      const framed = splitFrames(buffer);
      buffer = framed.rest;
      for (const line of framed.messages) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Unparseable input has no id to answer, so there is nobody to send an error to. Say so
          // on stderr and keep reading: one bad line must not end the session.
          warn(`nova acp: ignoring unparseable message (${line.length} bytes)`);
          continue;
        }
        await connection.receive(parsed);
      }
    }
    return 0;
  } finally {
    await connection.dispose();
  }
}

/**
 * The runtime's integer-unit price guard, from the provider's per-million rates.
 *
 * Deliberately the inexact form: the ACP path has no approved currency budget to enforce, so this
 * is only the runaway ceiling, and a catalog of 1/1 would make that ceiling meaningless.
 */
function priceCatalogFor(prices: { inputPerMillion: number; outputPerMillion: number } | undefined) {
  if (!prices) return { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 };
  return {
    inputRwfPerMillionTokens: Math.max(1, Math.round(prices.inputPerMillion / 1_000_000)),
    outputRwfPerMillionTokens: Math.max(1, Math.round(prices.outputPerMillion / 1_000_000)),
  };
}
