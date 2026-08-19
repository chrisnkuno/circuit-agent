"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { estimateTaskCost, type QualityTier, type TaskKind } from "@/lib/task-cost";
import { AgentBoard } from "@/components/agent-board";
import { IntegrationBoard } from "@/components/integration-board";
import { AuthPanel, useCurrentOrganization } from "@/components/auth-panel";
import { GyroscopeScene } from "@/components/gyroscope-scene";
import { CopyCommand } from "@/components/copy-command";
import { KageFurniture } from "@/components/kage-ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { useMoney } from "@/components/money-preferences";
import { authClient } from "@/lib/auth-client";

const CLI_COMMAND = "npm install -g @circuit-nova/nova-cli";

const taskKinds: { value: TaskKind; label: string; copy: string }[] = [
  { value: "coding", label: "Build or fix software", copy: "E2B sandbox, checks, review-ready evidence" },
  { value: "research", label: "Research a decision", copy: "Sources, synthesis, and a concise recommendation" },
  { value: "operations", label: "Run work operations", copy: "Plan, app actions, approval gates, and handoff" },
  { value: "writing", label: "Create a deliverable", copy: "Draft, revise, and package an artifact" },
];

/** One-click starting points for the command center — each fills the build input verbatim. */
const buildExamples = [
  "Build me an emergency response platform with an SOS system, responder dashboard, authentication and location tracking.",
  "Make a research dashboard that gathers sources on a topic, summarizes the evidence, and emails me a daily brief.",
  "Create a project tracker that posts approved updates to GitHub and my calendar every morning.",
];

const chapters = [
  { id: "work", num: "01", b: "Define the work", p: "Quote the cost of a task before it begins" },
  { id: "principles", num: "02", b: "Principles", p: "Durable, isolated, never silent" },
  { id: "integrations", num: "03", b: "Integrations", p: "Many apps, one controlled workflow" },
  { id: "agents", num: "04", b: "Agents", p: "Inspect the run graph and its gates" },
] as const;

const principles = [
  {
    num: "01", code: "DRB", b: "Durable by default", p: "Convex persists task plans, quotes, approvals, events, and payment holds.",
    detail: "Every stage of a run is written down before and after it happens, so a crash, a closed tab, or a new device never loses the state of your work.",
  },
  {
    num: "02", code: "ISO", b: "Isolated execution", p: "E2B runs code and browser work away from the user's device.",
    detail: "Code and browser work execute inside disposable E2B sandboxes, never on your laptop, so a run can explore, compile, and fail without touching your machine or credentials.",
  },
  {
    num: "03", code: "AUTH", b: "Human authority", p: "No overage, send, merge, or payment action happens silently.",
    detail: "Anything consequential — spending past a cap, sending a message, merging code, or moving money — stops at an approval gate that names the action and the amount before it runs.",
  },
] as const;

function normalizeAttachmentCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(10, Math.max(0, Math.trunc(parsed)));
}

function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" fill="#04070e" />
      {/* circuit traces */}
      <path d="M6 20h7l3-6h10" fill="none" stroke="#4f9dff" strokeWidth="1.3" />
      <path d="M6 12h6l3 4h11" fill="none" stroke="#4fd8ff" strokeWidth="1.3" />
      <circle cx="26" cy="6" r="2.4" fill="#4f9dff" />
      <circle cx="26" cy="26" r="2.4" fill="#4fd8ff" />
      <circle cx="6" cy="16" r="3" fill="#04070e" stroke="#4f9dff" strokeWidth="1.3" />
      <circle cx="6" cy="16" r="1.4" fill="#4f9dff" />
    </svg>
  );
}

/** Kage's signature word-by-word masked reveal — each word climbs out of its mask with a stagger. */
function WordReveal({ text, className = "" }: { text: string; className?: string }) {
  const words = text.split(" ");
  const lastIndex = words.length - 1;
  return (
    <h2 className={`${className} word-reveal`} data-rv="fade" aria-label={text}>
      {words.map((word, index) => (
        <span className="word-mask" key={`${word}-${index}`} aria-hidden="true">
          <span className="word" style={{ "--word-delay": `${0.06 * index}s` } as CSSProperties}>
            {word}
            {index < lastIndex ? "\u00A0" : ""}
          </span>
        </span>
      ))}
    </h2>
  );
}

/** Per-section foreground circuit glyphs — rise on scroll with a stagger, then sway (Kage's fg stages). */
const FG_SETS: { cls: string; left: string; top: string; d: string; w?: number; h?: number; sway?: boolean }[][] = [
  [
    { cls: "g-node", left: "10%", top: "72%", d: "0ms", sway: true },
    { cls: "g-node g-node--m", left: "89%", top: "16%", d: "130ms" },
    { cls: "g-trace", left: "4%", top: "58%", d: "260ms", w: 150 },
    { cls: "g-vtrace", left: "80%", top: "52%", d: "390ms", h: 96 },
    { cls: "g-corner", left: "47%", top: "84%", d: "520ms", sway: true },
  ],
  [
    { cls: "g-node g-node--m", left: "14%", top: "20%", d: "0ms" },
    { cls: "g-node", left: "84%", top: "74%", d: "140ms", sway: true },
    { cls: "g-vtrace", left: "8%", top: "44%", d: "280ms", h: 120 },
    { cls: "g-trace", left: "62%", top: "28%", d: "420ms", w: 170 },
    { cls: "g-corner", left: "24%", top: "88%", d: "560ms" },
  ],
];

function CircuitFurniture({ seed = 0 }: { seed?: number }) {
  const glyphs = FG_SETS[seed % FG_SETS.length];
  return (
    <div className="fg-scene" data-rv="fade" aria-hidden="true">
      {glyphs.map((g, index) => (
        <i
          key={index}
          className={`${g.cls}${g.sway ? " g-sway" : ""}`}
          style={{
            left: g.left,
            top: g.top,
            width: g.w ? `${g.w}px` : undefined,
            height: g.h ? `${g.h}px` : undefined,
            "--fg-delay": g.d,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}

export default function Home() {
  const [request, setRequest] = useState("");
  const [engaged, setEngaged] = useState(false); // input focus — wakes the core visualization
  const commandRef = useRef<HTMLTextAreaElement | null>(null);
  const [kind, setKind] = useState<TaskKind>("coding");
  const [quality, setQuality] = useState<QualityTier>("balanced");
  const [attachments, setAttachments] = useState(1);
  const [browser, setBrowser] = useState(false);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [cliOpen, setCliOpen] = useState(false); // CLI platform option reveals a copyable install command
  const selected = taskKinds.find((item) => item.value === kind)!;
  const effectiveTitle = title.trim() || selected.label;
  const quote = useMemo(() => estimateTaskCost({ kind, quality, attachmentCount: attachments, requiresBrowser: browser, requiresSandbox: kind !== "writing", taskText: effectiveTitle }), [attachments, browser, effectiveTitle, kind, quality]);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [kind, quality, attachments, browser, effectiveTitle]);

  const session = authClient.useSession();
  const organization = useCurrentOrganization();
  const createQuotedTask = useMutation(api.tasks.createQuotedTask);
  const { formatMoney, preference, rateDate } = useMoney();

  function resetStatus() {
    setStatus("idle");
    setError(null);
  }

  /** Auto-grows the build input with content, up to a readable ceiling. */
  function growCommandInput() {
    const el = commandRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
  }

  // Grows on value change (typing or an example chip filling it) — measuring after the DOM
  // has the new text, not before, so a chip-filled input never clips its first line.
  useEffect(() => { growCommandInput(); }, [request]);

  /** The command center's one real action: reserve a quoted task cap for the request. */
  async function launchBuild() {
    const objective = request.trim();
    if (!objective) return;
    if (!session.data) { setStatus("error"); setError("Sign in to start a build."); return; }
    if (!organization) { setStatus("error"); setError("Your workspace is still being set up. Try again in a moment."); return; }
    setStatus("pending");
    setError(null);
    try {
      await createQuotedTask({
        organizationId: organization._id,
        title: objective,
        kind,
        quality,
        estimateLowRwf: BigInt(quote.estimateLowRwf),
        estimateHighRwf: BigInt(quote.estimateHighRwf),
        maxRwf: BigInt(quote.maxRwf),
        confidence: quote.confidence,
        assumptions: quote.assumptions,
        idempotencyKey,
      });
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not reserve the task cap.");
    }
  }

  async function reserve() {
    if (!session.data) { setStatus("error"); setError("Sign in to reserve a task cap."); return; }
    if (!organization) { setStatus("error"); setError("Your workspace is still being set up. Try again in a moment."); return; }
    setStatus("pending");
    setError(null);
    try {
      await createQuotedTask({
        organizationId: organization._id,
        title: effectiveTitle,
        kind,
        quality,
        estimateLowRwf: BigInt(quote.estimateLowRwf),
        estimateHighRwf: BigInt(quote.estimateHighRwf),
        maxRwf: BigInt(quote.maxRwf),
        confidence: quote.confidence,
        assumptions: quote.assumptions,
        idempotencyKey,
      });
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not reserve the task cap.");
    }
  }

  return <div className="kage-page">
    <GyroscopeScene />
    <div className="kage-grain" aria-hidden="true" />
    <div className="kage-vignette" aria-hidden="true" />
    <KageFurniture />

    {/* Fixed navigation: wordmark, chapter links, auth, mobile menu. */}
    <header className="nav" id="nav">
      <a className="brand" href="#top">
        <BrandMark className="brand-mark" />
        <span className="brand-tx"><b>CIRCUIT·NOVA</b><i>Task-priced agent OS</i></span>
      </a>
      <nav className="nav-links">
        {chapters.map((chapter) => <a className="nav-link" key={chapter.id} href={`#${chapter.id}`}><span>{chapter.b}</span><span className="alt">{chapter.num} — {chapter.b}</span></a>)}
      </nav>
      <div className="nav-auth"><Link href="/growing-nova" className="nav-link">Growing Nova ↗</Link><ThemeToggle /><AuthPanel /></div>
      <button className="nav-burger" aria-label="Open menu"><i /><i /></button>
    </header>

    <main className="page">
      {/* Hero — the command center: one input, one question, a real build behind it. */}
      <section className={`hero${engaged ? " hero-engaged" : ""}`} id="top">
        <div className="hero-top">
          <p className="eyebrow"><span className="dot" />Task-priced agent operating system <span className="live">circuit live</span></p>
          <h1><span className="line"><span>What do you want</span></span><span className="line"><em>to build?</em></span></h1>
          <div className="command">
            <div className="command-row">
              <span className="command-prompt" aria-hidden="true">&gt;</span>
              <textarea
                ref={commandRef}
                className="command-input"
                rows={1}
                value={request}
                onChange={(event) => setRequest(event.target.value)}
                onFocus={() => setEngaged(true)}
                onBlur={() => setEngaged(false)}
                placeholder="Describe the project — Circuit plans it, prices it, and builds it in a real sandbox."
                aria-label="Describe what you want to build"
              />
            </div>
            <div className="command-examples">
              <span className="command-label">Try</span>
              {buildExamples.map((example) => (
                <button type="button" className="command-chip" key={example} title={example} onClick={() => setRequest(example)}>
                  {example}
                </button>
              ))}
            </div>
            <div className="command-cta-row">
              <button type="button" className="command-cta" onClick={launchBuild} disabled={!request.trim()}>
                <i />
                <span>Build with Circuit</span>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M2 11L11 2M11 2H4M11 2V9" stroke="currentColor" strokeWidth="1.2" /></svg>
              </button>
              <p className="command-meta">Quoted before work · Capped by your approval · Runs in a real sandbox</p>
            </div>
            <div className="platform">
              <div className="platform-links">
                <span className="platform-label">Run on</span>
                <a className="platform-link" href="/download">Desktop</a>
                <button
                  type="button"
                  className="platform-link"
                  aria-expanded={cliOpen}
                  aria-controls="cli-snippet"
                  onClick={() => setCliOpen((open) => !open)}
                >
                  CLI
                </button>
                <span className="platform-link platform-link--on" aria-current="page">Web</span>
              </div>
              <div className="platform-download">
                <a className="download-btn" href="/download">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1v7M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.2" /><path d="M2 11h8" stroke="currentColor" strokeWidth="1.2" /></svg>
                  <span>Download for Windows</span><span className="sub">· 64-bit</span>
                </a>
                <a className="download-note" href="/download#avx2">Older PC without AVX2? Learn more</a>
              </div>
            </div>
            {cliOpen && (
              <div className="cli-snippet" id="cli-snippet">
                <span className="cli-snippet-label">Install the CLI</span>
                <CopyCommand command={CLI_COMMAND} />
              </div>
            )}
          </div>
        </div>
        <div className="peek" aria-hidden="true">
          <div className="peek-fr">
            <span className="peek-grid" />
            <span className="peek-trace t1" />
            <span className="peek-trace t2" />
            <span className="peek-glow" />
            <span className="peek-core" />
            <span className="peek-node n1" />
            <span className="peek-node n2" />
            <span className="peek-node n3" />
          </div>
          <div className="peek-cap"><b>CORE</b><i>build pipeline — engages when you do</i></div>
        </div>
        <div className="hero-word" aria-hidden="true"><span>CIRCUIT·NOVA</span></div>
        <div className="hero-side"><span className="v">DESCRIBE · BUILD · RUN</span></div>
        <div className="hero-spacer" />
        <div className="hero-foot">
          <div className="hero-cue"><span>Scroll</span><span className="track"><i /></span></div>
          <div className="chapters">
            {chapters.map((chapter, index) => <button className="chip" key={chapter.id} data-chip={index}><span className="num">{chapter.num}</span><span className="tx"><b>{chapter.b}</b><p>{chapter.p}</p></span></button>)}
          </div>
        </div>
      </section>

      {/* How it works — the quote builder. */}
      <section className="sec" id="work">
        <CircuitFurniture seed={1} />
        <div className="sec-head" data-rv="up"><span className="k"><b>How it works</b></span><span className="rule" /></div>
        <div className="gate-grid" data-rv="up">
          <div className="builder">
            <div className="section-label">01 / Define the work</div>
            <WordReveal text="Know the cost of every build." />
            <div className="task-grid">{taskKinds.map((item) => <button className={kind === item.value ? "task-card selected" : "task-card"} key={item.value} onClick={() => { setKind(item.value); resetStatus(); }}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</div>
            <div className="controls">
              <label>Task title<input placeholder={selected.label} value={title} onChange={(event) => { setTitle(event.target.value); resetStatus(); }} /></label>
              <label>Quality<select value={quality} onChange={(event) => { setQuality(event.target.value as QualityTier); resetStatus(); }}><option value="fast">Fast — routine work</option><option value="balanced">Balanced — default</option><option value="expert">Expert — complex work</option></select></label>
              <label>Attached files<input min="0" max="10" step="1" type="number" value={attachments} onChange={(event) => { setAttachments(normalizeAttachmentCount(event.target.value)); resetStatus(); }} /></label>
              <label className="check"><input type="checkbox" checked={browser} onChange={(event) => { setBrowser(event.target.checked); resetStatus(); }} /> Includes browser or app work</label>
            </div>
          </div>
          <aside className="quote">
            <div className="quote-head"><span>02 / Your quote · {preference.currencyCode}</span><b className={`confidence ${quote.confidence}`}>{quote.confidence} confidence</b></div>
            <p className="task-name">{selected.label}</p>
            <div className="range"><strong>{formatMoney(quote.estimateLowRwf)}</strong><span>to</span><strong>{formatMoney(quote.estimateHighRwf)}</strong></div>
            <p className="quote-copy">Forecast from {quote.estimatedInputTokens.toLocaleString()} input and {quote.estimatedOutputTokens.toLocaleString()} output tokens. {preference.currencyCode === "RWF" ? "Ledger amount." : `Approximate daily conversion${rateDate ? ` (${rateDate})` : ""}; approval also shows the RWF ledger amount.`}</p>
            <div className="cap"><span>Never exceeds without approval</span><b>{formatMoney(quote.maxRwf)}</b></div>
            <ul>{quote.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
            <button className="primary" onClick={reserve} disabled={status === "pending"}>{status === "pending" ? "Reserving…" : "Reserve task cap"} <span>→</span></button>
            {status === "done" && <p className="notice">Task and quote persisted in Convex. Circuit Pay authorization is still blocked until its webhook contract is verified; execution awaits the dispatcher.</p>}
            {status === "error" && <p className="notice">{error}</p>}
          </aside>
        </div>
      </section>

      {/* Chapter II — principles. */}
      <section className="sec" id="principles">
        <CircuitFurniture seed={2} />
        <div className="sec-head" data-rv="up"><span className="k"><b>Principles</b></span><span className="rule" /></div>
        <div className="principles" data-rv="up">
          {principles.map((principle) => (
            <article className="principle" key={principle.num}>
              <span className="principle-num">{principle.num}</span>
              <div className="principle-body">
                <span className="principle-code">{principle.code}</span>
                <h3>{principle.b}</h3>
                <p className="principle-lead">{principle.p}</p>
                <p className="principle-detail">{principle.detail}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Chapter III — integrations. */}
      <section className="sec" id="integrations">
        <CircuitFurniture seed={3} />
        <div className="sec-head" data-rv="up"><span className="k"><b>Integrations</b></span><span className="rule" /></div>
        <IntegrationBoard organizationId={organization?._id} />
      </section>

      {/* Chapter IV — agents. */}
      <section className="sec" id="agents">
        <CircuitFurniture seed={4} />
        <div className="sec-head" data-rv="up"><span className="k"><b>Agents</b></span><span className="rule" /></div>
        <AgentBoard taskKind={kind} />
      </section>
    </main>

    {/* Manifesto footer. */}
    <footer className="foot">
      <div className="foot-grid">
        <div className="foot-brand">
          <BrandMark className="foot-mark" />
          <div><b>CIRCUIT·NOVA</b><p>A task-priced agent operating system — quoted in RWF before work begins, observable from your phone, and capped by your approval.</p></div>
        </div>
        <div><h4>Work</h4><ul><li><a href="#work">Define the work</a></li><li><a href="#principles">Principles</a></li></ul></div>
        <div><h4>Connect</h4><ul><li><a href="#integrations">Integrations</a></li><li><a href="#agents">Agents</a></li></ul></div>
      </div>
      <div className="foot-base"><span>© 2026 Circuit-Nova</span><span>Quoted before work · Capped by approval</span><span>Interface: Circuit Core</span></div>
    </footer>
  </div>;
}
