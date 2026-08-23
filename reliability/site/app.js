const $ = (id) => document.getElementById(id);
const fmt = (number) => Number(number || 0).toLocaleString();
const seconds = (milliseconds) =>
  `${(Number(milliseconds || 0) / 1_000).toFixed(1)}s`;
const fallback = { reports: [], catalog: { selection: [] } };

async function load() {
  try {
    const response = await fetch(`data.json?t=${Date.now()}`);
    if (!response.ok) throw new Error("Evidence is unavailable");
    return response.json();
  } catch {
    return fallback;
  }
}

function line(text, tone = "") {
  const element = document.createElement("div");
  element.className = tone;
  element.textContent = text;
  $("terminal").append(element);
  $("terminal").scrollTop = $("terminal").scrollHeight;
}

function timeline(report) {
  const rows = [];
  for (const journey of report?.observations || []) {
    rows.push([
      `› ${journey.name.toUpperCase()} · ${fmt(journey.actualTokens)} tokens · ${seconds(journey.elapsedMs)}`,
      "prompt",
    ]);
    const events = journey.events || [];
    if (events.length) {
      for (const event of events) {
        if (event.type === "tool_call") rows.push([`  ↳ ${event.tool}`, ""]);
        if (event.type === "tool_result")
          rows.push([
            `  ${event.isError ? "×" : "✓"} ${event.tool}`,
            event.isError ? "bad" : "ok",
          ]);
      }
    } else {
      rows.push([
        `  ${journey.toolCalls || 0} tools · ${journey.failedToolCalls || 0} failed`,
        journey.failedToolCalls ? "warn" : "ok",
      ]);
    }
    rows.push([
      `  ${journey.completed ? "PASS" : "FAIL"} · scope ${journey.scopeKept ? "kept" : "drifted"}`,
      journey.completed ? "ok" : "bad",
    ]);
  }
  return rows;
}

async function replay(report) {
  $("terminal").innerHTML = "";
  for (const [text, tone] of timeline(report)) {
    line(text, tone);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(320, 75 + text.length * 2)),
    );
  }
  line("\nrun complete · evidence published", "ok");
}

function safeArtifactUrl(value) {
  if (typeof value !== "string" || !value.startsWith("runs/latest/"))
    return null;
  const url = new URL(value, window.location.href);
  return url.origin === window.location.origin ? url : null;
}

async function showArtifact(journey) {
  const frame = $("artifact-frame");
  const text = $("artifact-text");
  const links = $("artifact-downloads");
  const artifact = journey?.artifact;
  $("artifact-label").textContent =
    artifact?.label || journey?.name || "No output";
  links.replaceChildren();
  frame.hidden = true;
  frame.removeAttribute("src");
  text.hidden = false;
  text.textContent = "No publishable artifact was recorded for this task.";
  if (!artifact) return;
  for (const download of artifact.downloads || []) {
    const url = safeArtifactUrl(download.url);
    if (!url) continue;
    const link = document.createElement("a");
    link.href = url.href;
    link.download = "";
    link.textContent = download.label;
    links.append(link);
  }
  const url = safeArtifactUrl(artifact.url);
  if (!url) return;
  if (artifact.kind === "web") {
    text.hidden = true;
    frame.hidden = false;
    frame.src = url.href;
    return;
  }
  try {
    const response = await fetch(url.href);
    if (!response.ok) throw new Error("output unavailable");
    text.textContent = await response.text();
  } catch {
    text.textContent = "The recorded output is unavailable.";
  }
}

function selectRunNode(journeys, index) {
  const nodes = [...document.querySelectorAll(".run-node")];
  nodes.forEach((node, nodeIndex) =>
    node.classList.toggle("active", nodeIndex === index),
  );
  showArtifact(journeys[index]);
}

async function replayRun(journeys) {
  const terminal = $("run-terminal");
  terminal.replaceChildren();
  for (let index = 0; index < journeys.length; index += 1) {
    selectRunNode(journeys, index);
    const journey = journeys[index];
    const row = document.createElement("div");
    row.className = journey.completed ? "ok" : "bad";
    row.textContent = `${journey.completed ? "✓" : "×"} ${journey.name} · ${journey.toolCalls || 0} tools · ${seconds(journey.elapsedMs)}`;
    terminal.append(row);
    terminal.scrollTop = terminal.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
}

function renderRunLab(report) {
  const journeys = report?.observations || [
    { name: "build" },
    { name: "web-build" },
    { name: "debug" },
    { name: "search" },
    { name: "defender" },
    { name: "resume" },
  ];
  const nodes = $("run-nodes");
  nodes.replaceChildren();
  journeys.forEach((journey, index) => {
    const button = document.createElement("button");
    button.className = "run-node";
    button.type = "button";
    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = journey.name;
    const detail = document.createElement("small");
    detail.textContent = journey.actualTokens
      ? `${fmt(journey.actualTokens)} tokens · ${journey.completed ? "verified" : "failed"}`
      : "awaiting evidence";
    copy.append(title, detail);
    button.append(number, copy);
    button.onclick = () => selectRunNode(journeys, index);
    nodes.append(button);
  });
  $("replay").onclick = () => replayRun(journeys);
  replayRun(journeys);
}

function renderControls(report) {
  const audits = report?.audits || [];
  const names = [
    "ui",
    "taskExecution",
    "memoryResume",
    "security",
    "approvals",
    "costAccuracy",
    "portability",
  ];
  $("controls").innerHTML = names
    .map((name) => {
      const matches = audits
        .flatMap((audit) => audit.categories || [])
        .filter((category) => category.name === name);
      const passed = matches.filter((category) => category.passed).length;
      const tests = matches.reduce(
        (sum, category) => sum + Number(category.tests || 0),
        0,
      );
      const label = name.replace(/([A-Z])/g, " $1");
      const healthy = matches.length > 0 && passed === matches.length;
      return `<div class="control ${healthy ? "healthy" : "pending-control"}"><span>${label}</span><b>${matches.length ? `${passed}/${matches.length} OS` : "awaiting audit"}</b><small>${fmt(tests)} focused tests</small></div>`;
    })
    .join("");
}

function render(data) {
  const reports = data.reports || [];
  const best = reports[0];
  const latest = data.current || best;
  if (latest) {
    $("score").textContent = latest.score;
    $("score-ring").style.setProperty("--score", `${latest.score}%`);
    $("grade").textContent = latest.grade;
    $("stamp").textContent =
      `${latest.model} · ${latest.generatedAt.slice(0, 10)}`;
    $("run-label").textContent = "latest run verified";
  } else {
    $("run-label").textContent = "waiting for first run";
  }

  const metrics = [
    ["TASK COMPLETION", latest ? `${latest.completionRate ?? 100}%` : "—"],
    ["OUTPUT QUALITY", latest ? `${latest.outputQualityRate ?? 100}%` : "—"],
    ["TOOL FAILURE RATE", latest ? `${latest.toolFailureRate ?? 0}%` : "—"],
    [
      "PROVIDER FAILURE RATE",
      latest ? `${latest.providerFailureRate ?? 0}%` : "—",
    ],
    [
      "MEDIAN LATENCY",
      latest?.medianLatencyMs ? seconds(latest.medianLatencyMs) : "—",
    ],
    ["CONTROL TESTS", latest?.auditTests ? fmt(latest.auditTests) : "—"],
    [
      "OS COVERAGE",
      latest?.auditPlatforms ? `${latest.auditPlatforms.length} / 3` : "—",
    ],
    ["TOTAL TOKENS", latest ? fmt(latest.actualTokens) : "—"],
    ["PREDICTION COVERAGE", latest ? `${latest.predictionCoverage}%` : "—"],
    ["LOGGED RUN ERRORS", fmt((data.errors || []).length)],
  ];
  $("metrics").innerHTML = metrics
    .map(
      ([label, value]) =>
        `<div class="metric"><span>${label}</span><b>${value}</b></div>`,
    )
    .join("");

  const tested = new Map(reports.map((report) => [report.model, report]));
  const candidates = [...(data.catalog?.selection || [])];
  if (
    latest &&
    !candidates.some((candidate) => candidate.model === latest.model)
  ) {
    candidates.unshift({
      model: latest.model,
      provider: "CircuitNotion",
      role: "paid baseline",
    });
  }
  $("leaderboard").innerHTML = candidates
    .map((candidate, index) => {
      const report = tested.get(candidate.model);
      return `<div class="model-row"><span class="rank">${String(index + 1).padStart(2, "0")}</span><div><b>${candidate.model}</b><small>${candidate.role || candidate.provider}</small></div><span class="model-score ${report ? "" : "pending"}">${report ? report.score : "queued"}</span></div>`;
    })
    .join("");

  renderRunLab(latest);
  renderControls(latest);
  replay(latest);
}

load().then(render);
