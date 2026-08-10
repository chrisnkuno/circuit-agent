import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal stand-in for `POST /v1/messages`, shaped exactly like Anthropic's real SSE stream.
 *
 * `anthropic-agent.ts` always sends `stream: true` (streaming is unconditional in this codebase —
 * see `onTextDelta` in `agent-runtime.ts`), so a plain JSON response is not enough: the
 * `@anthropic-ai/sdk` client would fail to parse it. Every event this emits mirrors the subset
 * `collectAnthropicStream` reads.
 */

export type StubTextTurn = {
  kind: "text";
  text: string;
  /** Splits `text` into multiple deltas with a pause between each, to simulate a slow answer. */
  chunkSize?: number;
  chunkDelayMs?: number;
};

export type StubToolCallTurn = {
  kind: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
  /** Prose the model utters before proposing the call, e.g. "I'll check that for you." */
  text?: string;
};

export type StubTurn = StubTextTurn | StubToolCallTurn;

export type AnthropicStub = {
  readonly url: string;
  /** Queues one scripted response per incoming request, consumed in arrival order. */
  enqueue(turn: StubTurn): void;
  requestCount(): number;
  close(): Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunksOf(text: string, size: number): string[] {
  if (size <= 0 || text.length <= size) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

export function startAnthropicStub(): Promise<AnthropicStub> {
  const queue: StubTurn[] = [];
  let requests = 0;

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    // The SDK sends its body before the handler needs it — this stub scripts by call order, not
    // content, but the request stream still has to be drained or the socket never completes.
    req.resume();
    requests += 1;
    const turn = queue.shift() ?? { kind: "text", text: "(stub had no scripted response queued)" };

    void respond(res, requests, turn).catch(() => {
      // The pty test that owns this response has already moved on (turn cancelled, process
      // exited); nothing downstream is listening for a write error on a half-closed socket.
      res.destroy();
    });
  });

  async function respond(res: http.ServerResponse, requestIndex: number, turn: StubTurn): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const messageId = `msg_stub_${requestIndex}`;
    send("message_start", {
      type: "message_start",
      message: { id: messageId, type: "message", role: "assistant", model: "claude-stub", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } },
    });

    let index = 0;
    let outputChars = 0;
    if (turn.kind === "tool_call" && turn.text) {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: turn.text } });
      send("content_block_stop", { type: "content_block_stop", index });
      outputChars += turn.text.length;
      index += 1;
    }
    if (turn.kind === "text") {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const chunk of chunksOf(turn.text, turn.chunkSize ?? 40)) {
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
        outputChars += chunk.length;
        if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
      }
      send("content_block_stop", { type: "content_block_stop", index });
    } else {
      const toolId = `toolu_stub_${requestIndex}`;
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name: turn.toolName } });
      const partialJson = JSON.stringify(turn.input);
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } });
      send("content_block_stop", { type: "content_block_stop", index });
      outputChars += partialJson.length;
    }

    send("message_delta", { type: "message_delta", delta: { stop_reason: turn.kind === "tool_call" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputChars } });
    send("message_stop", { type: "message_stop" });
    res.end();
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        enqueue: (turn) => queue.push(turn),
        requestCount: () => requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
