import readline from "node:readline";
import { NovaHost } from "./host.js";
function writeLine(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
function emit(event) {
    writeLine({ channel: "event", ...event });
}
const host = new NovaHost(emit);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
emit({ type: "ready" });
rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed)
        return;
    let request;
    try {
        request = JSON.parse(trimmed);
    }
    catch (error) {
        writeLine({
            channel: "response",
            id: "unknown",
            ok: false,
            error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
    }
    if (!request?.id || !request?.type) {
        writeLine({
            channel: "response",
            id: request?.id ?? "unknown",
            ok: false,
            error: "Request must include id and type",
        });
        return;
    }
    try {
        const result = await host.handle(request);
        writeLine({ channel: "response", id: request.id, ok: true, result });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", message });
        writeLine({ channel: "response", id: request.id, ok: false, error: message });
    }
});
rl.on("close", async () => {
    try {
        await host.handle({ id: "shutdown", type: "dispose" });
    }
    catch {
        // ignore dispose errors on exit
    }
    process.exit(0);
});
