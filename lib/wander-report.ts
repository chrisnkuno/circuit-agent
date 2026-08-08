import { extractWanderTopic } from "./wander-research";
import { WANDER_LAB_FILES } from "../packages/agent-core/src/wander";

export const WANDER_REPORT_PATH = "wander/REPORT.html";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Small markdown → HTML for the harvest report (headings, lists, bold, fenced code). */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let inList = false;
  let inCode = false;
  const flushList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushList();
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        html.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (/^###\s+/.test(line)) {
      flushList();
      html.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ""))}</h3>`);
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushList();
      html.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ""))}</h2>`);
      continue;
    }
    if (/^#\s+/.test(line)) {
      flushList();
      html.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ""))}</h1>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${escapeHtml(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) {
      html.push("");
      continue;
    }
    const withBold = escapeHtml(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html.push(`<p>${withBold}</p>`);
  }
  flushList();
  if (inCode) html.push("</code></pre>");
  return html.join("\n");
}

export type WanderReportSections = {
  topic: string;
  fetchedAt: string;
  evidence: string;
  hypotheses: string;
  reviewMethods: string;
  reviewRival: string;
  consensus: string;
};

/** Print-ready HTML briefing — open in a browser and Save as PDF. */
export function buildWanderReportHtml(input: WanderReportSections): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Wander — ${escapeHtml(input.topic)}</title>
<style>
  :root {
    --ink: #1a1f1c;
    --muted: #5c655e;
    --paper: #f7f4ec;
    --rule: #d4cfc0;
    --accent: #0f5c4c;
  }
  @page { margin: 18mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--ink);
    background: linear-gradient(180deg, #efe8d8 0%, var(--paper) 180px, var(--paper) 100%);
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    line-height: 1.55;
  }
  .page {
    max-width: 740px;
    margin: 0 auto;
    padding: 48px 28px 72px;
  }
  .mast {
    border-bottom: 2px solid var(--ink);
    padding-bottom: 18px;
    margin-bottom: 28px;
  }
  .brand {
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-size: 12px;
    color: var(--accent);
    font-weight: 700;
  }
  h1 {
    font-size: 34px;
    line-height: 1.15;
    margin: 10px 0 8px;
    font-weight: 700;
  }
  .meta { color: var(--muted); font-size: 14px; }
  section {
    margin: 34px 0;
    break-inside: avoid;
  }
  section h2 {
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    font-size: 13px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    border-top: 1px solid var(--rule);
    padding-top: 16px;
    margin: 0 0 12px;
  }
  h3 { font-size: 18px; margin: 18px 0 8px; }
  p { margin: 0 0 12px; }
  ul { margin: 0 0 14px; padding-left: 1.2em; }
  li { margin: 0 0 6px; }
  pre {
    background: #efeae0;
    border: 1px solid var(--rule);
    padding: 12px;
    overflow: auto;
    font-size: 13px;
  }
  .note {
    font-size: 13px;
    color: var(--muted);
    border-left: 3px solid var(--accent);
    padding-left: 12px;
    margin: 18px 0 28px;
  }
  table { border-collapse: collapse; width: 100%; margin: 0 0 14px; font-size: 14px; }
  th, td { border: 1px solid var(--rule); padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #efeae0; }
  @media print {
    body { background: white; }
    .page { padding: 0; max-width: none; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <main class="page">
    <header class="mast">
      <div class="brand">Wander lab report</div>
      <h1>${escapeHtml(input.topic)}</h1>
      <div class="meta">Literature scouted ${escapeHtml(input.fetchedAt)} · contested notebook · grades: verified / strong_plausible / speculative</div>
    </header>
    <p class="note">Print this page (or Save as PDF) for a portable briefing. Claims are only as strong as the Exa dossier and the critiques below — disagreement is intentional.</p>
    <section>
      <h2>Consensus</h2>
      ${markdownToHtml(input.consensus)}
    </section>
    <section>
      <h2>Principal investigator — hypotheses</h2>
      ${markdownToHtml(input.hypotheses)}
    </section>
    <section>
      <h2>Methodologist — review</h2>
      ${markdownToHtml(input.reviewMethods)}
    </section>
    <section>
      <h2>Rival theorist — review</h2>
      ${markdownToHtml(input.reviewRival)}
    </section>
    <section>
      <h2>Literature briefing</h2>
      ${markdownToHtml(input.evidence)}
    </section>
  </main>
</body>
</html>
`;
}

function findLabFile(files: Array<{ path?: string; content: string }>, relative: string): string {
  const normalized = relative.replace(/^\//, "");
  const hit = files.find((file) => {
    const path = (file.path ?? "").replace(/^\//, "");
    return path === normalized || path.endsWith(`/${normalized}`) || path.endsWith(normalized);
  });
  return hit?.content?.trim() ?? "";
}

/** Build the harvest report from captured notebook files. Returns null if consensus is missing. */
export function assembleWanderReport(options: {
  objective: string;
  files: Array<{ path?: string; content: string }>;
  /** Prefetched Exa briefing when EVIDENCE.md was not captured. */
  evidenceFallback?: string | null;
  fetchedAt?: string;
}): { path: string; html: string; topic: string; filename: string } | null {
  const consensus = findLabFile(options.files, WANDER_LAB_FILES.consensus);
  if (!consensus) return null;
  const topic = extractWanderTopic(options.objective) ?? "Wander research";
  const evidence = findLabFile(options.files, WANDER_LAB_FILES.evidence) || options.evidenceFallback?.trim() || "_No literature briefing captured._";
  const html = buildWanderReportHtml({
    topic,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    evidence,
    hypotheses: findLabFile(options.files, WANDER_LAB_FILES.hypotheses) || "_Missing HYPOTHESES.md_",
    reviewMethods: findLabFile(options.files, WANDER_LAB_FILES.reviewMethods) || "_Missing REVIEW_METHODS.md_",
    reviewRival: findLabFile(options.files, WANDER_LAB_FILES.reviewRival) || "_Missing REVIEW_RIVAL.md_",
    consensus,
  });
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "report";
  return {
    path: WANDER_REPORT_PATH,
    html,
    topic,
    filename: `wander-report-${slug}.html`,
  };
}
