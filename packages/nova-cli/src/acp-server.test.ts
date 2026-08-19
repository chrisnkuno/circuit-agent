import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { runAcpServer, splitFrames } from "./acp-server";

describe("acp stdio framing", () => {
  it("emits only complete messages and keeps the partial tail for the next chunk", () => {
    const first = splitFrames('{"a":1}\n{"b":2}\n{"c":');
    expect(first.messages).toEqual(['{"a":1}', '{"b":2}']);
    expect(first.rest).toBe('{"c":');

    const second = splitFrames(`${first.rest}3}\n`);
    expect(second.messages).toEqual(['{"c":3}']);
    expect(second.rest).toBe("");
  });

  it("loses nothing however a message is chopped up", () => {
    const messages = ['{"jsonrpc":"2.0","id":1,"method":"initialize"}', '{"jsonrpc":"2.0","method":"session/cancel"}'];
    const stream = `${messages.join("\n")}\n`;
    for (const size of [1, 3, 7, 40, 500]) {
      let buffer = "";
      const seen: string[] = [];
      for (let index = 0; index < stream.length; index += size) {
        buffer += stream.slice(index, index + size);
        const framed = splitFrames(buffer);
        buffer = framed.rest;
        seen.push(...framed.messages);
      }
      expect(seen).toEqual(messages);
      expect(buffer).toBe("");
    }
  });

  it("skips blank lines rather than treating them as empty messages", () => {
    expect(splitFrames('\n\n{"a":1}\n\n').messages).toEqual(['{"a":1}']);
  });
});

describe("acp server over a pipe", () => {
  function feed(lines: unknown[]) {
    return Readable.from([`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`]);
  }

  it("answers a handshake, and reports an unconfigured provider as an error on the wire rather than crashing", async () => {
    const written: string[] = [];
    const warnings: string[] = [];
    const code = await runAcpServer({
      input: feed([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
        { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd() } },
      ]),
      write: (line) => written.push(line),
      // Deliberately empty: no provider is configured, which is a first-run state a client must be
      // told about in a message it can render, not a stack trace on a channel it is parsing.
      environment: {},
      defaultRoot: process.cwd(),
      warn: (message) => warnings.push(message),
    });

    expect(code).toBe(0);
    const messages = written.map((line) => JSON.parse(line));
    expect(messages[0]).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    expect(messages[1]).toMatchObject({ id: 2, error: { message: expect.stringContaining("provider") } });
    // Every byte on the protocol channel is one complete JSON message and a newline.
    expect(written.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(true);
  });

  it("survives a garbage line: it warns off-channel and keeps serving", async () => {
    const written: string[] = [];
    const warnings: string[] = [];
    await runAcpServer({
      input: Readable.from(['not json at all\n{"jsonrpc":"2.0","id":9,"method":"initialize","params":{}}\n']),
      write: (line) => written.push(line),
      environment: {},
      defaultRoot: process.cwd(),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(written.map((line) => JSON.parse(line))).toMatchObject([{ id: 9, result: { protocolVersion: 1 } }]);
  });
});
