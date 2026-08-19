import type { Suggestion as EngineSuggestion } from "@circuit-nova/nova-core/nova-cli/suggestions";
import {
  defaultSignals,
  shouldOfferStarters,
  starterSuggestions,
  suggest as suggestFromSignals,
  type SessionSignals,
  type SuggestionCategory,
} from "@circuit-nova/nova-core/nova-cli/suggestions";
import { COMMANDS, type Command } from "./commands";
import { heading, note, type SectionStyle } from "./sections";
import { clipTo } from "./chooser";
import { visibleWidth } from "./markdown";
import { UNICODE_GLYPHS } from "./glyphs";
import type { PaletteEntry } from "./palette";
import { isSubsequence } from "./palette";

/**
 * Finding the right command without reading all of them.
 *
 * Nova has grown past forty slash commands and as many flags, and a list that long is not a menu —
 * it is a wall. The failure it produces is specific and measurable: people use the four commands
 * they learned on the first day and never discover `/undo`, `/diff` or `/detach`, because the only
 * ways in were an alphabetical dump (`/help`) and knowing the name already (Tab).
 *
 * Three things fix that, and none of them is "write shorter descriptions":
 *
 * **Group by intent.** Nobody wants "a command"; they want to see what changed, or to stop paying
 * so much, or to run two things at once. Six groups of five is navigable where thirty-eight in a
 * column is not.
 *
 * **Suggest from context, with the reason attached.** The agent just edited four files — the useful
 * next commands are `/diff` and `/undo`, and saying *why* they are being offered is what makes the
 * suggestion teach the command rather than merely fire it. A suggestion without a reason is an
 * advertisement.
 *
 * **Reveal progressively.** The short list first, everything behind one more keystroke. A tool that
 * shows you everything it can do, every time, is a tool you learn to skim past.
 */

export type NavGroupId = "work" | "review" | "steer" | "parallel" | "learn" | "setup";

export const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId; title: string }> = [
  { id: "work", title: "Do the work" },
  { id: "review", title: "See what happened" },
  { id: "steer", title: "Steer the agent" },
  { id: "parallel", title: "Run more than one thing" },
  { id: "learn", title: "Find your way around" },
  { id: "setup", title: "Set it up" },
];

/**
 * Which group each command belongs to.
 *
 * Exhaustive by test rather than by type: a command added without a group would otherwise quietly
 * vanish from grouped help, which is the one failure mode this whole module exists to prevent.
 */
export const COMMAND_GROUP: Readonly<Record<string, NavGroupId>> = {
  "/mode": "steer", "/plan": "steer", "/build": "steer", "/auto": "steer", "/defender": "steer",
  "/model": "steer", "/models": "steer", "/slow": "steer", "/clear": "steer", "/memory": "steer",
  "/todos": "review", "/diff": "review", "/undo": "work", "/cost": "review", "/expand": "review",
  "/history": "review", "/sessions": "review", "/scan": "work", "/wander": "work", "/voice": "work",
  "/files": "work", "/pull": "work", "/where": "review",
  "/jobs": "parallel", "/detach": "parallel", "/attach": "parallel", "/watch": "parallel",
  "/tab": "parallel", "/workspace": "parallel",
  "/guide": "learn", "/help": "learn", "/keys": "learn", "/palette": "learn", "/tools": "learn",
  "/edit": "work", "/exit": "steer",
  "/settings": "setup", "/providers": "setup", "/theme": "setup",
};

/**
 * Everything the suggester is allowed to know, in the CLI's own vocabulary.
 *
 * A projection of `SessionSignals` from the core package rather than a second set of rules: the
 * rules now live in one place and the desktop reads the same ones. What stays here is the mapping —
 * this is where a terminal's idea of "what happened" becomes the surface-neutral signals the engine
 * takes, and where a suggestion comes back as the slash command a reader can actually type.
 */
export type NavContext = {
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
  /** True once the session has spent anything worth looking at. */
  hasSpend: boolean;
  /** Findings the last scan reported, if one has run. */
  openFindings?: number;
  /** How the last turn ended, if one has — what makes a hint after a failure a way out of *that* failure. */
  lastStatus?: SessionSignals["lastStatus"];
  /** The error text from the last failure, so recovery can be specific rather than "try again". */
  lastError?: string | null;
  /** Fraction of a session budget spent, when one is set. */
  budgetFraction?: number;
  /** Commands used this session, most recent first. */
  recent: readonly string[];
};

/** The CLI context as the engine's signals. Commands used count as suggestions taken. */
export function navSignals(context: NavContext): SessionSignals {
  return defaultSignals({
    mode: context.mode,
    turns: context.turns,
    changedFiles: context.changedFiles,
    openTodos: context.openTodos,
    runningJobs: context.runningJobs,
    tabs: context.tabs,
    sandbox: context.sandbox,
    providerConfigured: context.providerConfigured,
    hasSpend: context.hasSpend,
    taken: context.recent,
    ...(context.openFindings !== undefined ? { openFindings: context.openFindings } : {}),
    ...(context.lastStatus !== undefined ? { lastStatus: context.lastStatus } : {}),
    ...(context.lastError !== undefined ? { lastError: context.lastError } : {}),
    ...(context.budgetFraction !== undefined ? { budgetFraction: context.budgetFraction } : {}),
  });
}

export type Suggestion = {
  command: string;
  /** Why *now* — shown beside the command, because a suggestion without a reason teaches nothing. */
  reason: string;
};

/**
 * What to do next, given where the session actually is — as commands this terminal can run.
 *
 * A thin projection of the shared engine: it asks for the categories a prompt should carry (a
 * blocking setup problem, a way out of a failure, the next ordinary step) and drops the ambient
 * teaching hints, which have their own quieter moment in `suggestHints`. Anything without a slash
 * command — "open a project", "try that again" — is filtered out by the engine itself, because it
 * has no desktop-free spelling here.
 */
export function suggestNext(context: NavContext, limit = 3): Suggestion[] {
  return fromEngine(context, ["blocked", "recovery", "next"], limit);
}

/**
 * The ambient half: a capability this session has not used that now applies.
 *
 * Kept apart from `suggestNext` on purpose. A next step is about the work in front of the reader
 * and is worth interrupting for; a teaching hint is not, and mixing the two would push the thing
 * they need under the thing they might one day like.
 */
export function suggestHints(context: NavContext, limit = 1): Suggestion[] {
  return fromEngine(context, ["discover"], limit);
}

function fromEngine(context: NavContext, categories: readonly SuggestionCategory[], limit: number): Suggestion[] {
  return suggestFromSignals(navSignals(context), { surface: "cli", limit, categories })
    .flatMap((suggestion) =>
      suggestion.action.kind === "command" ? [{ command: suggestion.action.command, reason: suggestion.reason }] : [],
    );
}

/**
 * The commands, in groups, with the ones that cannot apply left out.
 *
 * Filtering is the difference between a shorter list and a *relevant* one: `/pull` is meaningless
 * without a sandbox and `/attach` is meaningless with no jobs, and every irrelevant row costs the
 * reader the same attention as a useful one.
 */
/** How many commands a group shows before it says how many more there are. */
export const GROUP_PREVIEW = 4;

export function groupedCommands(context: NavContext, all = false): Array<{ id: NavGroupId; title: string; commands: Command[]; hidden: number }> {
  const applies = (command: Command): boolean => {
    if (all) return true;
    if (command.name === "/pull" && !context.sandbox) return false;
    if ((command.name === "/attach" || command.name === "/watch") && context.runningJobs === 0) return false;
    if (command.name === "/expand" && context.turns === 0) return false;
    if (command.name === "/undo" && context.turns === 0) return false;
    if (command.name === "/todos" && context.openTodos === 0) return false;
    // The mode you are already in is not a command, it is a statement.
    if (command.name === `/${context.mode}`) return false;
    return true;
  };
  const suggested = new Set(suggestNext(context, 6).map((suggestion) => suggestion.command));
  // Within a group: what the situation calls for, then what this session has already reached for,
  // then the catalog's own order. The first two are why the short list is worth trusting — a
  // preview that always shows the same four rows is a shorter wall, not a smaller problem.
  const rank = (command: Command): number => {
    if (suggested.has(command.name)) return 0;
    const recency = context.recent.indexOf(command.name);
    return recency >= 0 ? 1 + recency / 100 : 2;
  };
  return NAV_GROUPS.map((group) => {
    const members = COMMANDS
      .filter((command) => COMMAND_GROUP[command.name] === group.id && applies(command))
      .map((command, index) => ({ command, index }))
      .sort((left, right) => rank(left.command) - rank(right.command) || left.index - right.index)
      .map((entry) => entry.command);
    const shown = all ? members : members.slice(0, GROUP_PREVIEW);
    return { ...group, commands: shown, hidden: members.length - shown.length };
  }).filter((group) => group.commands.length > 0);
}

/**
 * Palette ranking, with the session's own situation as a tiebreaker.
 *
 * The literal-match tiers from `rankPaletteEntries` are untouched and still decide the order: a
 * name match must beat a description match whatever the context, or the palette stops being
 * trustworthy for the people who typed exactly what they wanted. Context only reorders entries
 * that already tie — which is precisely the empty-query case, where the catalog's fixed order is
 * the least useful thing that could be shown.
 */
export function contextBoost(command: string, context: NavContext): number {
  let boost = 0;
  const recency = context.recent.indexOf(command);
  if (recency >= 0) boost += Math.max(1, 6 - recency);
  // By position, not merely by membership: the suggester has already decided which of these the
  // situation calls for *most*, and flattening that to one bonus throws the ordering away exactly
  // where it matters — the empty query, which is the whole list in suggestion order.
  const suggested = suggestNext(context, 6).findIndex((suggestion) => suggestion.command === command);
  if (suggested >= 0) boost += 20 - suggested;
  if (COMMAND_GROUP[command] === "setup" && !context.providerConfigured) boost += 4;
  return boost;
}

export function rankWithContext(entries: readonly PaletteEntry[], query: string, context: NavContext): PaletteEntry[] {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  const tier = (entry: PaletteEntry): number => {
    if (!needle) return 0;
    const name = entry.command.replace(/^\//, "").toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (entry.description.toLowerCase().includes(needle)) return 2;
    if (isSubsequence(needle, name)) return 3;
    return 4;
  };
  return entries
    .map((entry, index) => ({ entry, index, tier: tier(entry), boost: contextBoost(entry.command, context) }))
    .filter((candidate) => candidate.tier < 4)
    .sort((left, right) => left.tier - right.tier || right.boost - left.boost || left.index - right.index)
    .map((candidate) => candidate.entry);
}

/**
 * The commands used this session, most recent first, without duplicates.
 *
 * In memory and session-scoped on purpose. Ranking by a history that outlives the session sounds
 * better and is worse: it makes the palette's order depend on work the user has since forgotten,
 * and the order of a menu that changes for reasons you cannot see is the definition of an interface
 * you cannot learn.
 */
export class CommandUsage {
  private readonly order: string[] = [];

  constructor(private readonly limit = 12) {}

  record(command: string): void {
    const name = command.trim().split(/\s+/)[0];
    if (!name.startsWith("/")) return;
    const existing = this.order.indexOf(name);
    if (existing >= 0) this.order.splice(existing, 1);
    this.order.unshift(name);
    if (this.order.length > this.limit) this.order.length = this.limit;
  }

  get recent(): readonly string[] {
    return this.order;
  }
}

/**
 * The in-session help: what applies here, grouped, with everything else one keystroke away.
 *
 * Two columns of name and description, clipped rather than wrapped, because a help screen that
 * reflows into paragraphs is one people stop scanning. The footer is the progressive-disclosure
 * half of the design and is not optional — a short list is only honest if the way to the long one
 * is on screen.
 */
export function renderGroupedHelp(context: NavContext, style: SectionStyle, options: { all?: boolean } = {}): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const groups = groupedCommands(context, options.all);
  const width = Math.max(32, style.width);
  // One column width for every row, and names clipped into it. A row whose name overruns the
  // column pushes its own description out of line, and a description column that is not a column
  // is the thing that makes a help screen unscannable.
  const nameWidth = Math.min(26, Math.max(...groups.flatMap((group) => group.commands.map((command) => (command.args ? `${command.name} ${command.args}` : command.name).length))));
  const nameCell = (command: Command) => clipTo(command.args ? `${command.name} ${command.args}` : command.name, nameWidth, glyphs).padEnd(nameWidth);
  const lines: string[] = [];

  const suggestions = suggestNext(context, 3);
  if (suggestions.length > 0 && !options.all) {
    lines.push(heading("Where you are", 2, style));
    for (const suggestion of suggestions) {
      lines.push(note(clipTo(`${suggestion.command.padEnd(nameWidth)}  ${suggestion.reason}`, width - 4, glyphs), style, "accent"));
    }
    lines.push("");
  }

  for (const group of groups) {
    lines.push(heading(group.title, 2, style));
    for (const command of group.commands) {
      lines.push(note(clipTo(`${nameCell(command)}  ${command.description}`, width - 4, glyphs), style));
    }
    if (group.hidden > 0) lines.push(note(`${" ".repeat(nameWidth)}  ${glyphs.ellipsis} ${group.hidden} more`, style));
    lines.push("");
  }

  // Trimmed to fit rather than clipped: a footer that ends in an ellipsis mid-sentence teaches
  // nothing, so the least important hint is dropped whole and the rest stays readable.
  const hints = options.all
    ? ["/palette searches all of these by what they do"]
    : ["/help all shows every command", "/palette searches them by what they do", "/keys for shortcuts"];
  const separator = ` ${glyphs.middot} `;
  const kept = [...hints];
  while (kept.length > 1 && visibleWidth(`${glyphs.middot} ${kept.join(separator)}`) > width - 4) kept.pop();
  lines.push(note(clipTo(`${glyphs.middot} ${kept.join(separator)}`, width - 4, glyphs), style));
  return lines.join("\n");
}

/**
 * The suggestion block printed where a turn ends: what to do next, and one thing worth knowing.
 *
 * Two rows at most for the work itself, because a third is where a hint stops being read — and one
 * ambient row beneath it only when the situation was quiet enough not to need two. The ambient row
 * is the "everywhere" half of being suggestive: it is how `/memory`, `/files` and `/tab` get found
 * by someone who never opens `/help`, and it is deliberately the first thing dropped when the
 * session has something more urgent to say.
 */
export function renderSuggestions(
  context: NavContext,
  style: SectionStyle,
  options: { limit?: number; hints?: boolean } = {},
): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(16, style.width - 4);
  const limit = Math.max(0, options.limit ?? 2);
  const next = suggestNext(context, limit);
  // Ambient teaching only in the space a next step did not need. A hint printed *under* two things
  // the reader has to decide about is a third thing to skip past, and the row people learn to skip
  // is the row nothing can ever be taught in again.
  const hints = options.hints && next.length < limit ? suggestHints(context, 1) : [];
  const rows = [...next, ...hints];
  if (rows.length === 0) return "";
  return rows
    .map((suggestion) => note(clipTo(`${suggestion.command} ${glyphs.middot} ${suggestion.reason}`, width, glyphs), style))
    .join("\n");
}

/**
 * One quiet teaching line, for a moment when a command had nothing of its own to say.
 *
 * An empty result — no plan yet, nothing changed since the checkpoint — is a whole screen of
 * attention spent on a single dim sentence. It is the cheapest place in the product to teach
 * something, and the only cost of doing it there is a line nobody was reading anyway.
 */
export function renderHint(context: NavContext, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const [hint] = suggestHints(context, 1);
  if (!hint) return "";
  return note(clipTo(`${hint.command} ${glyphs.middot} ${hint.reason}`, Math.max(16, style.width - 4), glyphs), style);
}

/**
 * The way out of a failure, printed under the error that caused it.
 *
 * An error message says what broke; this says what to do about it, which is a different sentence
 * and the one a reader actually needs. Nothing is printed when the failure is not one the rules
 * recognise — a made-up next step after a real error is worse than silence, because it costs a
 * detour to find out it was a guess.
 */
export function renderRecovery(context: NavContext, style: SectionStyle, limit = 2): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(16, style.width - 4);
  const rows = suggestNext(context, limit);
  if (rows.length === 0) return "";
  return rows
    .map((suggestion) => note(clipTo(`${suggestion.command} ${glyphs.middot} ${suggestion.reason}`, width, glyphs), style, "warn"))
    .join("\n");
}

/**
 * What to ask for at all, printed into a session that has not been asked anything yet.
 *
 * An empty prompt under a banner is the least suggestive thing a terminal can show: it says the
 * tool is ready without saying what it is ready *for*. These are three requests that are true of
 * any project and change nothing in it — the first thing a new reader types should not be an edit,
 * because nothing has yet taught them that the mode decides what Nova may do without asking.
 */
export function renderStarters(context: NavContext, style: SectionStyle, projectName?: string): string {
  const signals = { ...navSignals(context), ...(projectName ? { projectName } : {}) };
  if (!shouldOfferStarters(signals)) return "";
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(16, style.width - 4);
  const rows = starterSuggestions(signals).map((starter) =>
    note(clipTo(`${glyphs.middot} ${starter.label}`, width, glyphs), style),
  );
  return [heading("Try asking", 3, style), ...rows].join("\n");
}

/**
 * The model's extra suggestions, printed under the rules' own.
 *
 * Rendered differently on purpose: these are requests to *make*, not commands to run, and they are
 * guesses. The quote marks say the first thing and the mark says the second — a generated line that
 * looks exactly like a rule borrows credibility the rules earned by being checkable.
 */
export function renderAsks(suggestions: readonly EngineSuggestion[], style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(16, style.width - 4);
  return suggestions
    .flatMap((suggestion) =>
      suggestion.action.kind === "prompt"
        ? [note(clipTo(`~ "${suggestion.label}" ${glyphs.middot} ${suggestion.reason}`, width, glyphs), style)]
        : [],
    )
    .join("\n");
}
