import type { TurnStatus } from "./protocol";

/**
 * What to do next, decided from the session's own situation rather than from a model.
 *
 * Nova has two front ends, and until now each improvised its own idea of a hint: the CLI had a
 * one-line "next step" under the prompt driven by a table in `navigation.ts`, the desktop had three
 * hard-coded starter prompts and nothing else. Neither could learn from the other, and a rule added
 * to one silently did not exist in the other — which is how a product ends up feeling attentive in
 * a terminal and inert in a window.
 *
 * So the rules live here, once, as data:
 *
 * **Deterministic first.** Every suggestion in this file is a pure function of plain session
 * signals. No token is spent to produce one, none of them can be late, and every one of them is
 * reproducible in a test — which matters more than cleverness, because a hint that is occasionally
 * wrong is worse than no hint at all. A model may *add* to this (see `mergeModelSuggestions`), but
 * it may never displace it or reorder it.
 *
 * **A reason is not optional.** A suggestion without a reason is an advertisement: it fires a
 * command the reader did not choose and teaches nothing about when to choose it. Every rule here
 * states why *now*, in the same breath as what.
 *
 * **Surface-shaped, not surface-specific.** One rule, two renderings: the CLI runs `/diff`, the
 * desktop opens the diff panel. A rule that can only be expressed as a slash command simply has no
 * desktop action and is filtered out there, rather than being duplicated with a different name.
 *
 * **Taken means gone.** Anything already reached for this session drops out. This is the single
 * property that separates a hint bar from noise: a suggestion you have acted on is no longer a
 * suggestion, and repeating it teaches the reader to stop looking at the row it lives in.
 */

export type SuggestionSurface = "cli" | "desktop";

/**
 * Why a suggestion is on screen — and, because the categories are ordered, how loudly.
 *
 * - `blocked`  — nothing can happen until this is done. Shown alone; a menu beside a dead end is a
 *                distraction from the one thing that would revive it.
 * - `recovery` — the last thing tried failed, and this is the way out of that specific failure.
 * - `next`     — the work is fine and this is what the situation calls for next.
 * - `discover` — a capability this session has not touched that now applies. Ambient, never urgent.
 * - `starter`  — what to ask for at all, offered only into an empty transcript.
 */
export type SuggestionCategory = "blocked" | "recovery" | "next" | "discover" | "starter";

export const CATEGORY_ORDER: readonly SuggestionCategory[] = ["blocked", "recovery", "next", "discover", "starter"];

/**
 * What taking a suggestion does.
 *
 * `command` is a slash command the CLI can run as typed. `prompt` fills the input with a request
 * for the agent — deliberately *fills* rather than sends, on both surfaces, because a suggestion
 * that sends is a decision made on the reader's behalf. `ui` names a desktop affordance (a panel, a
 * dialog, a mode switch) that has no slash-command equivalent in a window.
 */
export type SuggestionAction =
  | { kind: "command"; command: string }
  | { kind: "prompt"; text: string }
  | { kind: "ui"; id: DesktopActionId };

/**
 * The desktop affordances a rule is allowed to point at.
 *
 * A closed set rather than free strings so that the adapter in the app is a total mapping the
 * compiler checks: a rule that points somewhere the window cannot go is a build error here, not a
 * dead chip a user clicks in production.
 */
export type DesktopActionId =
  | "open-settings"
  | "open-project"
  | "open-diff"
  | "open-scan"
  | "open-files"
  | "open-guide"
  | "open-models"
  | "open-sessions"
  | "undo-turn"
  | "pull-sandbox"
  | "new-tab"
  | "mode-plan"
  | "mode-build"
  | "mode-auto"
  | "mode-defender"
  | "retry-turn"
  | "dismiss-error";

export type Suggestion = {
  /** Stable across renders and sessions, so "already taken" can be recorded against it. */
  id: string;
  /** The chip's or line's text: short, imperative, and recognisable as the thing it will do. */
  label: string;
  /** Why this, why now. Never empty — enforced by test. */
  reason: string;
  category: SuggestionCategory;
  action: SuggestionAction;
  /** True when a model produced it rather than a rule, so a surface can mark it as a guess. */
  fromModel?: boolean;
};

/** Everything the rules are allowed to know. Plain data, so a test can pose any situation. */
export type SessionSignals = {
  mode: "plan" | "build" | "auto" | "defender";
  /** Turns completed in this session. Zero means nothing has happened yet. */
  turns: number;
  /** Files the agent has touched since the last checkpoint. */
  changedFiles: number;
  openTodos: number;
  runningJobs: number;
  tabs: number;
  sandbox: boolean;
  providerConfigured: boolean;
  /** Whether a project is open. The CLI always has one; a desktop window can be opened without. */
  projectOpen?: boolean;
  /** True once the session has spent anything worth looking at. */
  hasSpend: boolean;
  /** Findings the last scan reported, if one has run. */
  openFindings?: number;
  /** How the last turn ended, if one has. Drives the recovery rules. */
  lastStatus?: TurnStatus | null;
  /** The error text from the last failure, matched against for a *specific* way out. */
  lastError?: string | null;
  /** Fraction of the session's budget spent, if a budget is set. */
  budgetFraction?: number;
  /** Suggestion ids and commands already used this session, most recent first. */
  taken: readonly string[];
  /** The project folder's name, for starters that name it instead of saying "this project". */
  projectName?: string;
};

export function defaultSignals(overrides: Partial<SessionSignals> = {}): SessionSignals {
  return {
    mode: "build",
    turns: 0,
    changedFiles: 0,
    openTodos: 0,
    runningJobs: 0,
    tabs: 1,
    sandbox: false,
    providerConfigured: true,
    projectOpen: true,
    hasSpend: false,
    taken: [],
    ...overrides,
  };
}

/**
 * One rule: a situation, and what it implies on each surface.
 *
 * `when` returns the reason or null. Returning the *reason* rather than a boolean is what keeps the
 * count in "3 files changed" next to the condition that counted them, instead of in a formatter
 * that has to re-derive it and can disagree.
 */
type Rule = {
  id: string;
  category: SuggestionCategory;
  label: string;
  cli?: string;
  desktop?: SuggestionAction;
  when: (signals: SessionSignals) => string | null;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Whether a failure's text names a particular fault, so recovery can be specific rather than "try again". */
export type FailureKind = "auth" | "network" | "budget" | "limit" | "cancelled" | "unknown";

/**
 * Classifies a failure by what the reader has to *do* about it, not by where it was thrown.
 *
 * The distinction that matters is between a fault the reader can fix (a missing key, a cap), one
 * that fixes itself (a flaky network), and one that means the request was too big. Those want three
 * different next steps, and a single "something went wrong" hides all three.
 */
export function classifyFailure(signals: SessionSignals): FailureKind {
  if (signals.lastStatus === "cancelled") return "cancelled";
  if (signals.lastStatus === "iteration_limit") return "limit";
  const text = (signals.lastError ?? "").toLowerCase();
  if (!text) return "unknown";
  if (/\b(401|403)\b|api key|unauthorized|authentication|invalid[_ ]api|credential/.test(text)) return "auth";
  if (/fetch failed|enotfound|econnrefused|etimedout|network|socket hang up|dns|offline|\b(502|503|504)\b/.test(text)) return "network";
  if (/budget|spending cap|reserved model budget|quota|rate limit|\b429\b/.test(text)) return "budget";
  if (/iteration limit|too many steps|max steps/.test(text)) return "limit";
  return "unknown";
}

const failed = (signals: SessionSignals): boolean =>
  signals.lastStatus === "failed" || signals.lastStatus === "iteration_limit" || signals.lastStatus === "cancelled";

/**
 * The catalog, in priority order.
 *
 * The array's order *is* the ranking. A numeric weight would be a second thing to keep in step with
 * this order and would drift from it; a list you can read top to bottom cannot disagree with
 * itself. Categories are applied afterwards as a coarse sort, so a recovery rule written low in the
 * list still outranks an ordinary next step.
 */
const RULES: readonly Rule[] = [
  // ── blocked ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "configure-provider",
    category: "blocked",
    label: "Add a model provider",
    cli: "/settings",
    desktop: { kind: "ui", id: "open-settings" },
    when: (s) => (s.providerConfigured ? null : "no model provider is configured yet"),
  },
  {
    id: "open-project",
    category: "blocked",
    label: "Open a project",
    desktop: { kind: "ui", id: "open-project" },
    when: (s) => (s.projectOpen === false ? "Nova works inside a folder — open one to give it a project" : null),
  },

  // ── recovery ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "recover-auth",
    category: "recovery",
    label: "Check the API key",
    cli: "/settings",
    desktop: { kind: "ui", id: "open-settings" },
    when: (s) => (failed(s) && classifyFailure(s) === "auth" ? "the provider rejected the key — a wrong or expired one fails every turn the same way" : null),
  },
  {
    id: "recover-network",
    category: "recovery",
    label: "Check the provider",
    cli: "/providers",
    desktop: { kind: "ui", id: "open-settings" },
    when: (s) => (failed(s) && classifyFailure(s) === "network" ? "the endpoint could not be reached — the request never got as far as the model" : null),
  },
  {
    id: "recover-budget",
    category: "recovery",
    label: "See what it cost",
    cli: "/cost",
    desktop: { kind: "ui", id: "open-sessions" },
    when: (s) => (failed(s) && classifyFailure(s) === "budget" ? "the turn stopped at a cap — see where the spend went before raising it" : null),
  },
  {
    id: "recover-slow",
    category: "recovery",
    label: "Spend at a slower pace",
    cli: "/slow",
    when: (s) => (failed(s) && classifyFailure(s) === "budget" ? "fewer model rounds and smaller replies, so the next attempt fits" : null),
  },
  {
    id: "recover-limit",
    category: "recovery",
    label: "Ask for a smaller piece",
    cli: "/todos",
    desktop: { kind: "prompt", text: "That was too big to finish in one go. Do just the first step, and stop there." },
    when: (s) => (failed(s) && classifyFailure(s) === "limit" ? "the turn ran out of steps — a narrower request finishes where a broad one stalls" : null),
  },
  {
    id: "recover-retry",
    category: "recovery",
    label: "Try that again",
    desktop: { kind: "ui", id: "retry-turn" },
    when: (s) => {
      if (!failed(s)) return null;
      const kind = classifyFailure(s);
      return kind === "network" || kind === "cancelled" ? "the work itself was never rejected — only the attempt" : null;
    },
  },
  {
    id: "recover-undo",
    category: "recovery",
    label: "Put the files back",
    cli: "/undo",
    desktop: { kind: "ui", id: "undo-turn" },
    when: (s) => (failed(s) && s.changedFiles > 0 ? `${plural(s.changedFiles, "file")} changed before it stopped — a half-finished edit is worth reverting` : null),
  },

  // ── next ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: "first-guide",
    category: "next",
    label: "Read the guide",
    cli: "/guide",
    desktop: { kind: "ui", id: "open-guide" },
    when: (s) => (s.turns === 0 ? "a short tour, if this is your first session" : null),
  },
  {
    id: "first-palette",
    category: "next",
    label: "Search the commands",
    cli: "/palette",
    when: (s) => (s.turns === 0 ? "search every command by what it does" : null),
  },
  {
    id: "fix-findings",
    category: "next",
    label: "Work through the findings",
    cli: "/defender",
    desktop: { kind: "ui", id: "mode-defender" },
    when: (s) =>
      s.openFindings !== undefined && s.openFindings > 0 && s.mode !== "defender"
        ? `${plural(s.openFindings, "security finding")} to work through`
        : null,
  },
  {
    id: "review-diff",
    category: "next",
    label: "See what changed",
    cli: "/diff",
    desktop: { kind: "ui", id: "open-diff" },
    when: (s) => (s.changedFiles > 0 ? `${plural(s.changedFiles, "file")} changed and not looked at yet` : null),
  },
  {
    id: "undo-turn",
    category: "next",
    label: "Undo the last turn",
    cli: "/undo",
    desktop: { kind: "ui", id: "undo-turn" },
    when: (s) => (s.changedFiles > 0 ? "put the last turn back if it went the wrong way" : null),
  },
  {
    id: "plan-to-build",
    category: "next",
    label: "Switch to build",
    cli: "/build",
    desktop: { kind: "ui", id: "mode-build" },
    when: (s) => (s.mode === "plan" && s.turns > 0 ? "the plan is in context — switch to build to apply it" : null),
  },
  {
    id: "open-todos",
    category: "next",
    label: "See the plan",
    cli: "/todos",
    when: (s) => (s.openTodos > 0 ? `${plural(s.openTodos, "item")} still open on the agent's plan` : null),
  },
  {
    id: "watch-jobs",
    category: "next",
    label: "Check the jobs",
    cli: "/jobs",
    when: (s) => (s.runningJobs > 0 ? `${plural(s.runningJobs, "job")} running in the background` : null),
  },
  {
    id: "open-workspace",
    category: "next",
    label: "Watch everything at once",
    cli: "/workspace",
    when: (s) => (s.runningJobs > 0 && (s.tabs > 1 || s.runningJobs > 1) ? "watch everything at once on one screen" : null),
  },
  {
    id: "pull-sandbox",
    category: "next",
    label: "Copy the work here",
    cli: "/pull",
    desktop: { kind: "ui", id: "pull-sandbox" },
    when: (s) => (s.sandbox ? "the work is in a sandbox — copy it here when it is right" : null),
  },
  {
    id: "watch-budget",
    category: "next",
    label: "Spend at a slower pace",
    cli: "/slow",
    when: (s) => (s.budgetFraction !== undefined && s.budgetFraction >= 0.75 ? `${Math.round(s.budgetFraction * 100)}% of this session's budget is gone` : null),
  },
  {
    id: "see-cost",
    category: "next",
    label: "See what it cost",
    cli: "/cost",
    when: (s) => (s.hasSpend && s.turns >= 3 ? "what this session has spent, per turn" : null),
  },
  {
    id: "detach-work",
    category: "next",
    label: "Send work to the background",
    cli: "/detach",
    desktop: { kind: "ui", id: "new-tab" },
    when: (s) => (s.turns >= 2 && s.changedFiles === 0 && s.runningJobs === 0 ? "send long work to the background and keep the prompt" : null),
  },

  // ── discover ──────────────────────────────────────────────────────────────────────────────────
  // Ambient, and deliberately last: each names something this session has not used that now
  // applies. The gates are thresholds rather than timers, so a hint arrives because the session has
  // reached the point where the feature would have helped — not because a clock went off.
  {
    id: "learn-memory",
    category: "discover",
    label: "Remember a fact",
    cli: "/memory",
    when: (s) => (s.turns >= 2 ? "start a line with # to remember something for every future session here" : null),
  },
  {
    id: "learn-scan",
    category: "discover",
    label: "Scan for secrets",
    cli: "/scan",
    desktop: { kind: "ui", id: "open-scan" },
    when: (s) => (s.openFindings === undefined && s.turns >= 2 ? "a deterministic secret scan of the project — no model turn needed" : null),
  },
  {
    id: "learn-files",
    category: "discover",
    label: "Browse the project",
    cli: "/files",
    desktop: { kind: "ui", id: "open-files" },
    when: (s) => (s.turns >= 1 ? "pick a file to @mention instead of typing the path" : null),
  },
  {
    id: "learn-tabs",
    category: "discover",
    label: "Work in a second tab",
    cli: "/tab",
    desktop: { kind: "ui", id: "new-tab" },
    when: (s) => (s.tabs === 1 && s.turns >= 4 ? "a second piece of work, without losing this conversation" : null),
  },
  {
    id: "learn-history",
    category: "discover",
    label: "Search past sessions",
    cli: "/history",
    desktop: { kind: "ui", id: "open-sessions" },
    when: (s) => (s.turns >= 4 ? "every past conversation in this project, searchable" : null),
  },
  {
    id: "learn-model",
    category: "discover",
    label: "Change the model",
    cli: "/model",
    desktop: { kind: "ui", id: "open-models" },
    when: (s) => (s.turns >= 3 ? "a cheaper or stronger model, keeping this conversation" : null),
  },
  {
    id: "learn-plan-mode",
    category: "discover",
    label: "Try plan mode",
    cli: "/plan",
    desktop: { kind: "ui", id: "mode-plan" },
    when: (s) => (s.mode !== "plan" && s.turns >= 3 ? "read and reason with no writes, for work you want to agree on first" : null),
  },
  {
    id: "learn-theme",
    category: "discover",
    label: "Change the colours",
    cli: "/theme",
    when: (s) => (s.turns >= 6 ? "starry-night, starry-dawn, nebula, high-contrast, or a theme of your own" : null),
  },
];

/**
 * The starter prompts for an empty transcript.
 *
 * Read-only on purpose. The first thing a new reader clicks should not propose an edit, because
 * nothing has yet taught them that the mode decides what Nova may do without asking — and a first
 * click that changes their files is how a tool loses trust it never gets back.
 */
export function starterSuggestions(signals: SessionSignals): Suggestion[] {
  const here = signals.projectName ? `${signals.projectName}` : "this project";
  const starters: readonly { id: string; text: string; reason: string }[] = [
    { id: "starter-tour", text: `What does ${here} do, and how is it laid out?`, reason: "the fastest way to find out whether Nova has understood the project" },
    { id: "starter-tests", text: "Run the tests and tell me what fails", reason: "reads the project and proves it can run it, without changing anything" },
    { id: "starter-risk", text: "Find the riskiest thing in this codebase", reason: "a review pass — it looks, it does not touch" },
  ];
  return starters.map((starter) => ({
    id: starter.id,
    label: starter.text,
    reason: starter.reason,
    category: "starter" as const,
    action: { kind: "prompt" as const, text: starter.text },
  }));
}

/** Whether the empty-transcript starters belong on screen at all. */
export function shouldOfferStarters(signals: SessionSignals, busy = false): boolean {
  return signals.turns === 0 && !busy && signals.providerConfigured && signals.projectOpen !== false;
}

export type SuggestOptions = {
  surface: SuggestionSurface;
  limit?: number;
  /** Which categories to consider. Omitted, everything but `starter`, which has its own moment. */
  categories?: readonly SuggestionCategory[];
  busy?: boolean;
};

/**
 * What to do next, given where the session actually is.
 *
 * Three filters, in this order: the rule must fire, it must have an action this surface can
 * perform, and it must not already have been taken. Then a stable sort by category — a blocking
 * rule written at the bottom of the catalog still comes first — and, within a category, the
 * catalog's own order, which is the priority the rules were written in.
 *
 * A `blocked` suggestion is returned alone. Everything else on screen beside a dead end is a
 * distraction from the single thing that would end it.
 */
export function suggest(signals: SessionSignals, options: SuggestOptions): Suggestion[] {
  const limit = Math.max(0, options.limit ?? 3);
  if (limit === 0) return [];
  const categories = new Set(options.categories ?? (["blocked", "recovery", "next", "discover"] as const));
  const taken = new Set(signals.taken);

  const matched: Suggestion[] = [];
  // Two rules can land on the same action from different angles — a failed turn that also changed
  // files reaches `/undo` as both recovery and review. The first one to fire wins, because it is
  // the higher-priority framing of the same act, and the second would be the same button twice.
  const claimed = new Set<string>();
  for (const rule of RULES) {
    if (!categories.has(rule.category)) continue;
    const action: SuggestionAction | undefined =
      options.surface === "cli" ? (rule.cli ? { kind: "command", command: rule.cli } : undefined) : rule.desktop;
    if (!action) continue;
    // Both the rule's id and the command it runs count as "taken": a reader who typed `/diff`
    // themselves has reviewed the diff just as surely as one who clicked the chip, and the hint
    // that survives that is the one that makes the row feel like it is not listening.
    if (taken.has(rule.id)) continue;
    if (action.kind === "command" && taken.has(action.command)) continue;
    const reason = rule.when(signals);
    if (!reason) continue;
    const key = action.kind === "command" ? action.command : action.kind === "ui" ? action.id : action.text;
    if (claimed.has(key)) continue;
    claimed.add(key);
    matched.push({ id: rule.id, label: rule.label, reason, category: rule.category, action });
  }

  const blocked = matched.filter((suggestion) => suggestion.category === "blocked");
  if (blocked.length > 0) return blocked.slice(0, 1);

  const rank = (suggestion: Suggestion) => CATEGORY_ORDER.indexOf(suggestion.category);
  return matched
    .map((suggestion, index) => ({ suggestion, index }))
    .sort((left, right) => rank(left.suggestion) - rank(right.suggestion) || left.index - right.index)
    .map((entry) => entry.suggestion)
    .slice(0, limit);
}

/**
 * Folds model-written suggestions in behind the deterministic ones.
 *
 * The rules are the contract and the model is a guest: its entries are appended, never interleaved,
 * capped, marked `fromModel` so a surface can show them as guesses, and dropped when they duplicate
 * a rule that already fired or an action already taken. That ordering is the whole reason the
 * optional model path is safe to turn on — the worst it can do is add a row, and the row says so.
 */
export function mergeModelSuggestions(
  base: readonly Suggestion[],
  fromModel: readonly Suggestion[],
  options: { limit?: number; maxModel?: number } = {},
): Suggestion[] {
  const limit = Math.max(0, options.limit ?? base.length + 2);
  const maxModel = Math.max(0, options.maxModel ?? 2);
  const seen = new Set(base.map((suggestion) => suggestion.id));
  const extra: Suggestion[] = [];
  for (const suggestion of fromModel) {
    if (extra.length >= maxModel) break;
    if (seen.has(suggestion.id) || !suggestion.reason.trim() || !suggestion.label.trim()) continue;
    seen.add(suggestion.id);
    extra.push({ ...suggestion, fromModel: true });
  }
  return [...base, ...extra].slice(0, limit);
}

/** Every rule id, for tests and for a surface that wants to record "taken" against a known set. */
export function suggestionIds(): string[] {
  return RULES.map((rule) => rule.id);
}

/**
 * The optional model pass: what a model may add, and the narrow shape it may add it in.
 *
 * Off unless a person turns it on, and constrained in three ways that together make it safe to
 * leave in the product:
 *
 * **It can only propose prompts.** A model suggestion is always something to *ask for*, never a
 * command to run or a panel to open. A rule can point at `/undo`; a generated line cannot, because
 * the worst outcome of a bad rule is a wasted click and the worst outcome of a bad generated action
 * is a revert nobody asked for.
 *
 * **It never displaces a rule.** `mergeModelSuggestions` appends, caps and marks. The deterministic
 * list is identical whether this ran, failed, or was never enabled.
 *
 * **It fails silently.** A suggestion is the least important thing on screen; a session must never
 * see an error, a delay it notices, or a bill it did not expect because the hint bar could not
 * think of anything. Any failure returns nothing at all.
 */
export const SUGGESTION_SYSTEM_PROMPT = [
  "You suggest what a developer might ask a coding agent to do next, based on what just happened.",
  "Reply with a JSON array and nothing else. At most 2 objects, each {\"ask\": string, \"why\": string}.",
  "\"ask\" is a request addressed to the agent, under 12 words, specific to this project.",
  "\"why\" is under 12 words and says what about the session makes it worth doing now.",
  "Suggest nothing that was already done. If nothing is worth suggesting, reply with [].",
].join("\n");

/** Parses the model's reply. Anything malformed yields nothing — a half-read guess is still a guess. */
export function parseModelSuggestions(text: string): Suggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const suggestions: Suggestion[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const ask = (entry as { ask?: unknown }).ask;
    const why = (entry as { why?: unknown }).why;
    if (typeof ask !== "string" || typeof why !== "string") continue;
    const label = ask.trim();
    const reason = why.trim();
    if (!label || !reason) continue;
    suggestions.push({
      id: `model-${index}-${label.slice(0, 24)}`,
      label,
      reason,
      category: "next",
      action: { kind: "prompt", text: label },
      fromModel: true,
    });
  }
  return suggestions;
}

/** The one-line description of the session the model is given. Deliberately facts, not transcript. */
export function describeSituation(signals: SessionSignals, lastRequest?: string, lastSummary?: string): string {
  const facts = [
    `mode: ${signals.mode}`,
    `turns so far: ${signals.turns}`,
    `files changed since the last checkpoint: ${signals.changedFiles}`,
    `open plan items: ${signals.openTodos}`,
    ...(signals.openFindings === undefined ? [] : [`open security findings: ${signals.openFindings}`]),
    ...(signals.lastStatus ? [`the last turn ended: ${signals.lastStatus}`] : []),
  ];
  return [
    ...(lastRequest ? [`They last asked: ${lastRequest.slice(0, 400)}`] : []),
    ...(lastSummary ? [`The agent reported: ${lastSummary.slice(0, 600)}`] : []),
    facts.join(" · "),
  ].join("\n");
}

export type SuggestionModel = {
  complete(request: {
    messages: { role: "system" | "user"; content: string }[];
    maxOutputTokens: number;
  }): Promise<{ content: string }>;
};

/**
 * Asks a model for a couple of extra suggestions. Returns nothing on any failure, by design.
 *
 * The caller still has to merge the result through `mergeModelSuggestions`; this function does not
 * do it, so that the one place the two lists meet is the one place the ordering rule is enforced.
 */
export async function askModelForSuggestions(
  model: SuggestionModel,
  signals: SessionSignals,
  context: { lastRequest?: string; lastSummary?: string; maxOutputTokens?: number } = {},
): Promise<Suggestion[]> {
  try {
    const turn = await model.complete({
      messages: [
        { role: "system", content: SUGGESTION_SYSTEM_PROMPT },
        { role: "user", content: describeSituation(signals, context.lastRequest, context.lastSummary) },
      ],
      maxOutputTokens: context.maxOutputTokens ?? 300,
    });
    return parseModelSuggestions(turn.content);
  } catch {
    return [];
  }
}
