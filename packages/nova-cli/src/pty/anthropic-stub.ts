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

export type StubErrorTurn = {
  kind: "error";
  status: number;
  message: string;
};

export type StubTurn = StubTextTurn | StubToolCallTurn | StubErrorTurn;

/** One request as the CLI actually sent it, for tests that assert on what the model was told. */
export type StubRequest = {
  model?: string;
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
};

export type AnthropicStub = {
  readonly url: string;
  /** Queues one scripted response per incoming request, consumed in arrival order. */
  enqueue(turn: StubTurn): void;
  requestCount(): number;
  /** Every request body received so far, in arrival order. */
  requests(): StubRequest[];
  /** Replaces what `GET /v1/models` lists. Empty means the endpoint answers with no models. */
  setModels(ids: readonly string[]): void;
  /** How many times the model list has been asked for. */
  modelListCount(): number;
  close(): Promise<void>;
};

/**
 * What `GET /v1/models` lists unless a test says otherwise.
 *
 * Deliberately not the ids in the price catalog: the whole point of asking a provider what it has
 * is to discover models this build was not compiled knowing about, so a stub that only ever
 * returns familiar ids cannot tell a working fetch from one whose result is being dropped.
 */
export const STUB_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-vega-6-20270114", // not in any catalog: proves a live id survives to the caller
  "text-embedding-3-large", // not conversational: proves the caller filters
] as const;

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
  const received: StubRequest[] = [];
  let requests = 0;
  let modelIds: string[] = [...STUB_MODELS];
  let modelListRequests = 0;

  const server = http.createServer((req, res) => {
    // The model list, which is not an optional extra: a key is validated by asking for it, and the
    // model picker is populated from it. A stub that serves only `/v1/messages` makes every caller
    // that checks a key look like a caller talking to a provider that is down.
    if (req.method === "GET" && req.url?.replace(/\?.*$/, "").endsWith("/models")) {
      req.resume();
      modelListRequests += 1;
      const body = JSON.stringify({ data: modelIds.map((id) => ({ id, type: "model" })) });
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    // The request stream has to be drained either way or the socket never completes. Kept rather
    // than discarded because *what the model was told* is the only external evidence of some
    // behaviour — a resumed session is indistinguishable from a fresh one until you look at
    // whether the earlier transcript was actually sent.
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { raw += chunk; });
    req.on("end", () => {
      let body: StubRequest = { messages: [] };
      try {
        const parsed = JSON.parse(raw) as StubRequest;
        body = { ...parsed, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
      } catch {
        // Left as the empty request: a test asserting on what was sent should see nothing rather
        // than a plausible-looking guess.
      }
      received.push(body);
      requests += 1;
      const turn = queue.shift() ?? { kind: "text", text: "(stub had no scripted response queued)" };

      // Answering only once the body has arrived, so the reply can echo the model that was asked
      // for. The real API does that, and a caller pricing a turn from the model named in the
      // response gets a name its rate card has never heard of if the stub invents one instead.
      void respond(res, requests, turn, body.model ?? "claude-stub").catch(() => {
        // The pty test that owns this response has already moved on (turn cancelled, process
        // exited); nothing downstream is listening for a write error on a half-closed socket.
        res.destroy();
      });
    });
  });

  async function respond(res: http.ServerResponse, requestIndex: number, turn: StubTurn, model: string): Promise<void> {
    if (turn.kind === "error") {
      const type = turn.status === 429 ? "rate_limit_error"
        : turn.status === 401 ? "authentication_error"
        : turn.status >= 500 ? "api_error"
        : "invalid_request_error";
      res.writeHead(turn.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type, message: turn.message } }));
      return;
    }
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
      message: { id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } },
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
        requests: () => received.map((request) => ({ ...request, messages: [...request.messages] })),
        setModels: (ids) => { modelIds = [...ids]; },
        modelListCount: () => modelListRequests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
