import { spawn } from "node:child_process";
import readline from "node:readline";
import { readFileSync } from "node:fs";
const key = JSON.parse(readFileSync("/home/chris/.nova/credentials.json", "utf8")).CIRCUITNOTION_API_KEY;
const child = spawn("node", ["sidecar/dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => console.log("STDERR:", String(d).slice(0, 300)));
child.on("exit", (c) => console.log("child exited:", c));
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map(); const events = [];
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.channel === "event") { events.push(m); return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
let n = 0;
const call = (req, ms = 90000) => new Promise((resolve) => {
  const id = `r${++n}`;
  const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "TIMEOUT" }); }, ms);
  pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
  child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
});
const settings = { provider: "circuitnotion", apiKey: key, baseUrl: "", model: "gpt-5.6-luna" };
const a = await call({ type: "settings.set", settings });
console.log("settings:", a.ok, a.error ?? "");
const s = await call({ type: "session.scratch", mode: "build" });
console.log("scratch:", s.ok, JSON.stringify(s.ok ? s.result : s.error).slice(0, 300));
if (s.ok) {
  const t = await call({ type: "turn.send", objective: "Reply with exactly: PONG" }, 150000);
  console.log("turn:", t.ok, JSON.stringify(t.ok ? t.result : t.error).slice(0, 200));
  const d = events.filter((e) => e.payload?.type === "assistant_delta").map((e) => e.payload.text);
  console.log("deltas:", d.length, JSON.stringify(d.join("").slice(0, 80)));
}
child.kill();
process.exit(0);
