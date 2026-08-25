import { COMMANDS } from "./commands";
import { GUTTER, clip, note, panel, rule, type SectionStyle } from "./sections";
import { UNICODE_GLYPHS } from "./glyphs";
import { BOLD, DIM, paint, paintAll } from "./ansi";
import { visibleWidth } from "./markdown";

/**
 * The manual, inside the thing it documents.
 *
 * `/help` lists commands, which answers "what can I type" and never "how does this work". Nothing
 * told a new user that tabs can each run a different model, that memory is a file they can edit, or
 * that a background job does not inherit their sandbox — all of which are the kind of thing people
 * discover by being surprised.
 *
 * Two constraints shape this:
 *
 * - **It lives in the CLI, not in a README.** A guide you have to leave the terminal to read is a
 *   guide consulted once. `/guide` costs nothing to open mid-session and closes without losing the
 *   conversation.
 * - **It cannot go stale quietly.** Every command named here is checked against the registry, and
 *   every registered command has to be covered by some topic. A feature added without a line in the
 *   guide fails the test suite, which is the only mechanism that has ever kept documentation
 *   honest.
 */

export type GuideExample = {
  /** Typed exactly as shown. */
  input: string;
  /** What it does, in one line. */
  effect: string;
};

export type GuideTopic = {
  id: string;
  title: string;
  /** One sentence, shown in the index. */
  summary: string;
  /** The body, as paragraphs. Wrapped to the terminal at render time. */
  body: string[];
  examples?: GuideExample[];
  /** Commands this topic documents, for the coverage check. */
  covers: string[];
};

export const GUIDE_TOPICS: GuideTopic[] = [
  {
    id: "start",
    title: "Getting started",
    summary: "What Nova is, and the first thing to type.",
    body: [
      "Nova is a coding agent that works in a scrolling terminal transcript. You type what you want in plain language; it reads files, runs commands and edits code, and shows you what it did as it goes.",
      "Everything it prints stays in your terminal's scrollback, so you can scroll up, select text and pipe a session to a file the way you would with any other command.",
      "Type a request and press Enter. Slash commands do everything else — press / to see them, or open the searchable list.",
    ],
    examples: [
      { input: "fix the failing test in cart.ts", effect: "an ordinary request; Nova reads, edits and runs the tests" },
      { input: "/help", effect: "every command, with one line each" },
      { input: "/palette", effect: "search commands by name or by what they do" },
      { input: "/guide", effect: "open this guide as a screen — arrows to move, / to search, q to leave" },
      { input: "/guide tabs", effect: "print one topic into the transcript, to keep or to copy" },
      { input: "/exit", effect: "leave; the session is saved and can be resumed" },
    ],
    covers: ["/help", "/palette", "/exit", "/keys", "/guide"],
  },
  {
    id: "modes",
    title: "Permission modes",
    summary: "How much Nova may do without asking.",
    body: [
      "Four modes, and you can change them at any time. Plan reads and reasons but cannot write or run commands. Build is the default: edits are proposed and you approve them. Auto applies ordinary workspace edits without asking, while anything sensitive or reaching outside the workspace still stops for you. Defender turns Nova into a security reviewer — full tool access to actually scan and fix, but never auto-approved, the same posture as Build.",
      "Defender also looks outward: when web search is configured it checks current advisories against what the project actually depends on, remembers durable findings in project memory so the next review builds on this one, and closes out with concrete, costed remediation resources fitted to how the project actually hosts and deploys — not a generic checklist.",
      "/scan runs the deterministic half of defender's own secrets playbook directly — no model turn, no mode switch needed. It is the same pattern-matching scan_secrets uses, worst severity first: a private key or a live cloud credential ahead of a merely credential-shaped variable name.",
      "The mode is per tab, so one piece of work can be on a short leash while another runs freely.",
    ],
    examples: [
      { input: "/plan", effect: "read-only: no writes, no commands" },
      { input: "/build", effect: "edits ask first (the default)" },
      { input: "/auto", effect: "ordinary edits apply; sensitive actions still ask" },
      { input: "/defender", effect: "security review — find and fix real issues; every change still asks" },
      { input: "/mode", effect: "show which mode you are in" },
      { input: "/scan", effect: "pattern-based secret scan, worst severity first, no model call" },
      { input: "/scan src/**", effect: "same scan, limited to files matching the glob" },
    ],
    covers: ["/mode", "/plan", "/build", "/auto", "/defender", "/scan"],
  },
  {
    id: "tabs",
    title: "Tabs: several pieces of work, one at a time",
    summary: "Each tab keeps its own conversation, model, cost and machine — the tab in front is the one that runs.",
    body: [
      "A tab is a separate piece of work with its own conversation, its own running total, its own mode — and its own model and location. One tab can be on a large model against your checkout while another runs a cheaper or open model inside a throwaway remote sandbox.",
      "Only the tab in front runs. Switching away does not leave a turn working in the background — it pauses that piece of work and hands the terminal to another one. That is a deliberate limit rather than a missing feature: a terminal transcript has one bottom, and two agents printing into it at once would interleave into something neither of them said. (Nova's desktop window is different — it has a transcript per tab, so its tabs really do run at the same time.)",
      "When you want work running while you do something else, that is what /detach and /jobs are for: a detached job keeps going after you close the terminal, and /watch streams it into the session without taking the prompt.",
      "Tabs keep what they printed. Leave one and come back and the last lines reappear, so you can pick up where you were instead of facing a bare prompt.",
      "The strip above the prompt shows every tab with its model and a mark for where it runs. Closing a tab that started its own sandbox stops that sandbox — and only that one.",
    ],
    examples: [
      { input: "/tab new review", effect: "a second tab, same model, same machine" },
      { input: "/tab new fast --model claude-haiku-4-5-20251001", effect: "a tab on a different model" },
      { input: "/tab new risky --sandbox e2b", effect: "a tab whose edits land in a remote sandbox, not on your disk" },
      { input: "/tab 2", effect: "switch to tab 2 and replay where you left off" },
      { input: "/tab close 2", effect: "close it, stopping its sandbox if it started one" },
      { input: "/detach run the full test suite", effect: "work that runs while you use another tab" },
    ],
    covers: ["/tab"],
  },
  {
    id: "models",
    title: "Models and providers",
    summary: "Choosing what runs, and what it costs.",
    body: [
      "Nova talks to several providers. The picker lists what you can use, with prices, and offers to save a key for anything you cannot use yet. Switching model keeps the conversation — you are changing who answers, not starting over.",
      "The list is the union of what this build knows the prices of and what each provider says it has today, so a model released last week is still offerable — it is simply shown without a price rather than hidden. The live half is cached for six hours; /models refresh asks again.",
      "A model switch applies to the tab you are in. Opening a tab with --model is how you compare two models on the same problem.",
    ],
    examples: [
      { input: "/models", effect: "the list, with prices" },
      { input: "/models refresh", effect: "ask every provider what it has right now" },
      { input: "/model", effect: "the picker" },
      { input: "/model claude-sonnet-5", effect: "switch straight to one, keeping the transcript" },
      { input: "/fallback openai:gpt-5.4-mini", effect: "retry transient provider failures on this model, only before any output or tool action" },
      { input: "/providers", effect: "which providers are configured" },
    ],
    covers: ["/models", "/model", "/fallback", "/providers", "/settings"],
  },
  {
    id: "where",
    title: "Where the work happens",
    summary: "This machine, a container, or a remote sandbox.",
    body: [
      "By default Nova edits the directory you started it in. Started with --sandbox e2b it works inside a throwaway remote machine instead, and --sandbox docker uses a local container. Files written there never touch your disk unless you ask for them.",
      "Sandboxes are per tab, so 'try this somewhere I don't mind breaking' is one command rather than a second terminal.",
      "One thing worth knowing: background jobs always run on your machine, even when the session that started them is sandboxed. Nova says so each time you start one.",
    ],
    examples: [
      { input: "nova --sandbox e2b", effect: "the whole session runs in a remote sandbox" },
      { input: "/tab new spike --sandbox docker", effect: "one tab in a local container" },
      { input: "/where", effect: "which machine the current tab is using" },
      { input: "/pull", effect: "copy files out of a sandbox and onto your disk" },
    ],
    covers: ["/where", "/pull"],
  },
  {
    id: "reading",
    title: "Reading what Nova did",
    summary: "Code, diffs, test results, and folded detail.",
    body: [
      "When Nova writes or edits a file it shows the code, numbered, under the tool line. When it runs tests it re-lays the output into sections with the failures pulled out. When output is long it is folded rather than truncated, and the whole of it is one command away.",
      "The diff shows the actual patch since the last checkpoint — the lines, not a count of them.",
    ],
    examples: [
      { input: "/diff", effect: "the real patch, file by file" },
      { input: "/diff stat", effect: "just the summary of how much changed" },
      { input: "/expand", effect: "unfold the last folded block" },
      { input: "/expand list", effect: "everything that has been folded this session" },
      { input: "/undo", effect: "revert the last turn — files, conversation, or both" },
      { input: "/retry", effect: "repeat a failed request when nothing had run or changed" },
      { input: "/continue", effect: "finish an interrupted task without repeating completed work" },
      { input: "/todos", effect: "the agent's current plan" },
    ],
    covers: ["/diff", "/expand", "/undo", "/retry", "/continue", "/todos"],
  },
  {
    id: "memory",
    title: "Memory",
    summary: "Facts worth keeping between sessions.",
    body: [
      "Telling Nova the same thing every session costs you tokens and patience. A remembered fact is prepended to the conversation instead.",
      "Memory is a plain markdown file you can open, edit, commit or delete. Project memory belongs to the repository; personal memory follows you across projects. Nothing is remembered unless you say so.",
    ],
    examples: [
      { input: "# we use bun, not npm", effect: "remember a fact about this project" },
      { input: "/memory", effect: "list what is remembered" },
      { input: "/memory add --user I prefer terse explanations", effect: "remember something about you, everywhere" },
      { input: "/memory forget 2", effect: "drop one" },
    ],
    covers: ["/memory"],
  },
  {
    id: "history",
    title: "History",
    summary: "Past conversations, searchable and resumable.",
    body: [
      "Every session is saved. You can list them, search the ones you half-remember, read one back, or pick one up and keep going with its whole context intact.",
    ],
    examples: [
      { input: "/history", effect: "recent sessions, newest first" },
      { input: "/history search failing tests", effect: "find one by what you typed" },
      { input: "/history resume", effect: "pick up where a past session left off" },
      { input: "/export support", effect: "write a compact redacted artifact safe to attach to a support request" },
      { input: "/clear", effect: "start a fresh thread in this tab" },
    ],
    covers: ["/history", "/sessions", "/export", "/clear"],
  },
  {
    id: "cost",
    title: "Cost and pace",
    summary: "Knowing what you are spending, and spending it slower.",
    body: [
      "Every turn is priced in your own currency, and the running total is always on screen. Start with --budget N to approve a cap that is then enforced rather than merely reported.",
      "Slow mode is the other half: it limits how many model rounds and tool calls a turn may use, shortens replies, and pauses between turns. It caps the rate, not the total, and asks before an unusually expensive turn.",
    ],
    examples: [
      { input: "/cost", effect: "the breakdown for this session" },
      { input: "nova --budget 20", effect: "approve and enforce a cap" },
      { input: "/slow", effect: "spend at a gentler pace" },
      { input: "/slow strict", effect: "slower still, with a pause between turns" },
      { input: "/slow off", effect: "back to full speed" },
    ],
    covers: ["/cost", "/slow"],
  },
  {
    id: "pay",
    title: "Paying from the terminal",
    summary: "Topping up your Nova credit without leaving the prompt.",
    body: [
      "/pay creates a payment and gives you a link and a short code. You pay on Circuit Pay's own page — Nova never sees your card, your PIN or your mobile-money confirmation, and never asks for them.",
      "Nothing is charged until you answer the confirmation, and the amount you approve is the amount that appears on the checkout. Amounts are whole RWF: Nova refuses a decimal rather than rounding money you typed.",
      "While it waits, Ctrl+C returns you to the prompt without cancelling the payment. If it is still unconfirmed when you stop waiting, Nova says so and keeps the reference rather than calling it failed — a payment that has not been confirmed is not a payment that has failed, and paying twice is the mistake worth designing against. /pay status <reference> picks it up later.",
      "/pay on its own shows the balance. When CircuitNotion billing is configured, Nova also checks after a turn and calmly warns if the confirmed balance is low, below the critical 500 RWF level, or has fallen unusually fast. If that endpoint is unavailable, /balance <amount> stores the balance you see in your account and tracks a clearly labelled local estimate by subtracting measured token costs after completed turns. /balance clear returns to the endpoint. Before a demanding task, Nova compares its token-based estimate with whichever balance source you chose and stops before contacting the model when even the conservative estimate cannot fit.",
      "Paying needs NOVA_BILLING_URL and NOVA_BILLING_KEY set in /settings; without both, /pay says so instead of half-working.",
    ],
    examples: [
      { input: "/pay 5000", effect: "top up 5,000 RWF" },
      { input: "/pay", effect: "what the balance is" },
      { input: "/balance 5000", effect: "track a 5,000 RWF balance locally without the endpoint" },
      { input: "/balance clear", effect: "return to the provider balance endpoint" },
      { input: "/pay status CP-91f2", effect: "check a payment you stopped waiting for" },
    ],
    covers: ["/pay", "/balance"],
  },
  {
    id: "updating",
    title: "Keeping Nova current",
    summary: "Automatic updates by default, with explicit check-only and off controls.",
    body: [
      "Nova looks for a new version once a day, at the moment a session starts and never in the middle of one. The check is bounded at three seconds and its failure is silent: an unreachable registry costs one attempt a day, not a slow prompt.",
      "By default Nova installs a newer release automatically through whichever package manager installed it; it does not wait for another acceptance prompt. /update check changes that to notification-only behavior, and /update off stops it looking at all.",
      "Automatic installs never happen in a piped or headless run, or in CI, because automation may depend on an exact installed version. A version that fails to install is remembered and not retried, because an update mechanism that fails loudly every launch is one people uninstall.",
      "An install replaces the program on disk; the session you are in keeps running the version it started with until you restart it.",
    ],
    examples: [
      { input: "/update", effect: "install the newest version now" },
      { input: "/update check", effect: "tell you about updates without installing" },
      { input: "/update off", effect: "stop looking for updates" },
    ],
    covers: ["/update"],
  },
  {
    id: "background",
    title: "Background work",
    summary: "Jobs that outlive the prompt, and research that runs itself.",
    body: [
      "Work can be sent to the background and keeps running after you close the terminal. A watched job streams its output into the session without taking the prompt, so you can read it when you want to and carry on meanwhile.",
      "This — not tabs — is how two things run at once in the terminal. A tab you switch away from is paused; a detached job keeps working.",
      "Wander runs a bounded research lab on a topic, gathers evidence first, and grades its own claims. It can run once or on a schedule.",
      "A job that needs approval says so and waits — attach to it to answer.",
    ],
    examples: [
      { input: "/detach update the changelog", effect: "start it in the background" },
      { input: "/jobs", effect: "what is running, queued or finished" },
      { input: "/watch 20260814T0132Z-ab12cd", effect: "follow its output without giving up the prompt" },
      { input: "/watch show <id>", effect: "read what it has said so far" },
      { input: "/attach <id>", effect: "take the prompt to answer an approval" },
      { input: "/wander daily coral reefs", effect: "a research lab, every day" },
    ],
    covers: ["/detach", "/jobs", "/attach", "/watch", "/wander"],
  },
  {
    id: "panel",
    title: "The control panel",
    summary: "Every tab and job, live, on one screen.",
    body: [
      "The workspace is a full-screen view of everything at once: each tab as a pane showing its live output, what model it is running and where, and each watched job alongside them.",
      "It is a view — it reads the session and changes nothing — so leaving it puts you back exactly where you were.",
      "Inside it: 1-9 select a pane, arrows or Tab move between them, arrows or j/k scroll, g and G jump to the ends, q leaves.",
    ],
    examples: [
      { input: "/workspace", effect: "open the panel" },
      { input: "q", effect: "leave it and return to the prompt" },
    ],
    covers: ["/workspace"],
  },
  {
    id: "look",
    title: "How it looks",
    summary: "Themes, symbols, and terminals that need help.",
    body: [
      "Nova ships a starry-night theme and three others, and reads themes you write yourself as .tss files in .nova/themes — the same format TermUI apps use, so a palette written once works in both.",
      "If your terminal draws question marks instead of symbols, --ascii switches to characters every terminal has. If you would rather have a status line pinned to the bottom row, --pin does that, at the cost of your terminal's scrollback.",
    ],
    examples: [
      { input: "/theme list", effect: "every theme available, including your own" },
      { input: "/theme nebula", effect: "change the colours immediately" },
      { input: "/theme where", effect: "where to put a theme file of your own" },
      { input: "nova --ascii", effect: "plain characters for terminals that mangle symbols" },
    ],
    covers: ["/theme"],
  },
  {
    id: "extend",
    title: "Tools and voice",
    summary: "What the agent can call, and talking to it.",
    body: [
      "Nova has a fixed set of built-in tools, and a project can add more through skills, plugins, MCP servers and hooks. The tools command shows exactly what is available in this project.",
      "Voice input records or transcribes a prompt you can edit before sending.",
      "The file picker is the project as a tree rather than a flat completion list: expand a folder, preview a file's contents, and pick one to drop an @mention into the line you're writing.",
      "`/edit <path>` opens a file in the built-in editor. It reads and writes through the workspace like every tool does, so it edits the sandbox's copy in a sandboxed session rather than a same-named file on this machine, and it only writes when you save — quitting really is a discard.",
    ],
    examples: [
      { input: "/tools", effect: "every tool, skill, plugin, MCP server and hook" },
      { input: "/voice", effect: "record a prompt, then edit it before sending" },
      { input: "/files", effect: "browse the project tree and @mention a file" },
      { input: "/edit src/app.ts", effect: "open a file in the built-in editor" },
    ],
    covers: ["/tools", "/voice", "/files", "/edit"],
  },
];

/** Every command the guide claims to document. */
export function documentedCommands(): Set<string> {
  return new Set(GUIDE_TOPICS.flatMap((topic) => topic.covers));
}

/** Registered commands no topic covers — the check that keeps this file honest. */
export function undocumentedCommands(): string[] {
  const documented = documentedCommands();
  return COMMANDS.map((command) => command.name).filter((name) => !documented.has(name));
}

export function findTopic(id: string): GuideTopic | undefined {
  const wanted = id.trim().toLowerCase();
  return GUIDE_TOPICS.find((topic) => topic.id === wanted)
    ?? GUIDE_TOPICS.find((topic) => topic.title.toLowerCase().includes(wanted));
}

/** Topics whose title, summary or body mention the query. */
export function searchTopics(query: string): GuideTopic[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return GUIDE_TOPICS;
  return GUIDE_TOPICS.filter((topic) =>
    [topic.title, topic.summary, ...topic.body, ...(topic.examples ?? []).flatMap((example) => [example.input, example.effect])]
      .some((text) => text.toLowerCase().includes(needle)));
}

/**
 * Wraps prose to the terminal.
 *
 * The guide is the one part of the CLI that is mostly paragraphs, and a paragraph that runs off the
 * right edge is one a person stops reading. Words longer than the measure are emitted whole rather
 * than broken — a hyphenated command name is worse than a long line.
 */
export function wrapText(text: string, width: number): string[] {
  // No floor on the measure: a caller that asks for eight columns gets eight. Clamping here once
  // hid a wrapping bug behind a minimum that production never hit.
  const measure = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === "") { current = word; continue; }
    if (visibleWidth(current) + 1 + visibleWidth(word) <= measure) current = `${current} ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** The index: what there is to read, and how to read it. */
export function renderGuideIndex(style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const available = Math.max(8, style.width - GUTTER.length);
  const longest = Math.max(...GUIDE_TOPICS.map((topic) => topic.id.length));
  const rows = GUIDE_TOPICS.map((topic) => {
    const id = paint(topic.id.padEnd(longest + 2), style.depth === "none" ? "" : DIM, style.depth);
    // The title is what gets cut on a narrow window, never the id — the id is the thing you type.
    return `${GUTTER}${id}${clip(topic.title, Math.max(0, available - longest - 2), glyphs)}`;
  });
  return [
    rule(style, { label: "nova guide", tone: "accent" }),
    ...rows,
    "",
    note(clip("/guide <topic> · /guide search <text> · /guide all", Math.max(0, style.width - GUTTER.length * 2), glyphs), style),
  ].join("\n");
}

/** One topic, in full. */
export function renderGuideTopic(topic: GuideTopic, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const measure = Math.max(20, style.width - GUTTER.length * 2);
  const parts: string[] = [
    rule(style, { label: topic.title, tone: "accent" }),
    "",
  ];

  for (const paragraph of topic.body) {
    for (const line of wrapText(paragraph, measure)) parts.push(`${GUTTER}${line}`);
    parts.push("");
  }

  if (topic.examples && topic.examples.length > 0) {
    const inner = Math.max(8, style.width - GUTTER.length - 4);
    const longest = Math.max(...topic.examples.map((example) => visibleWidth(example.input)));
    const bold = (text: string) => paintAll(text, [style.depth === "none" ? "" : BOLD], style.depth);
    const dim = (text: string) => paint(text, style.depth === "none" ? "" : DIM, style.depth);
    // Two columns only while the explanation still has room to be an explanation. Past half the
    // panel the command column starves it, and a truncated "a tab whose edits land in a remote s…"
    // teaches nothing — so the pair stacks instead, which costs a row and keeps the sentence.
    const stacked = longest > Math.floor(inner / 2);
    const rows = topic.examples.flatMap((example) => stacked
      ? [bold(example.input), `  ${dim(clip(example.effect, inner - 2, glyphs))}`]
      : [`${bold(example.input.padEnd(longest + 2))}${dim(clip(example.effect, inner - longest - 2, glyphs))}`]);
    parts.push(panel(rows, style, { title: "try", tone: "accent" }));
  }

  const next = GUIDE_TOPICS[GUIDE_TOPICS.indexOf(topic) + 1];
  // `note` indents twice, so the pointer has two gutters less room than the measure above it.
  if (next) {
    parts.push(note(
      clip(`next: /guide ${next.id} ${glyphs.middot} ${next.title}`, Math.max(0, style.width - GUTTER.length * 2), glyphs),
      style,
    ));
  }
  return parts.join("\n");
}

/** Everything, for someone who wants to read it end to end or pipe it to a file. */
export function renderWholeGuide(style: SectionStyle): string {
  return [
    renderGuideIndex(style),
    "",
    ...GUIDE_TOPICS.map((topic) => renderGuideTopic(topic, style)),
  ].join("\n");
}

export type GuideCommand =
  | { kind: "index" }
  | { kind: "all" }
  | { kind: "topic"; id: string }
  | { kind: "search"; query: string }
  | { kind: "unknown"; id: string };

/** Parses `/guide`, `/guide <topic>`, `/guide search <text>`, `/guide all`. */
export function parseGuideCommand(input: string): GuideCommand | null {
  const match = /^\/(?:guide|tutorial)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim().replace(/\s+/g, " ");
  if (!rest) return { kind: "index" };

  const [verb, ...words] = rest.split(" ");
  if (verb.toLowerCase() === "all") return { kind: "all" };
  if (verb.toLowerCase() === "search") {
    const query = words.join(" ").trim();
    return query ? { kind: "search", query } : { kind: "index" };
  }
  // Anything else is read as a topic, and a miss is reported rather than silently showing the
  // index — "/guide tabss" printing the front page looks exactly like the command not working.
  return findTopic(rest) ? { kind: "topic", id: findTopic(rest)!.id } : { kind: "unknown", id: rest };
}
