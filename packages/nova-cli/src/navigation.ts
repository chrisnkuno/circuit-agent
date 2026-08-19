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

/** Everything the suggester is allowed to know. Plain data, so a test can pose any situation. */
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
  /** Commands used this session, most recent first. */
  recent: readonly string[];
};

export type Suggestion = {
  command: string;
  /** Why *now* — shown beside the command, because a suggestion without a reason teaches nothing. */
  reason: string;
};

/**
 * What to do next, given where the session actually is.
 *
 * Ordered by how much the situation demands it rather than by how clever the suggestion is: an
 * unconfigured provider outranks everything because nothing else can happen, and unreviewed changes
 * outrank a cost breakdown because one of them is about correctness and the other is about
 * curiosity. Anything the user has already run this session is dropped — a suggestion they have
 * taken is no longer a suggestion, and repeating it is how a hint bar becomes noise.
 */
export function suggestNext(context: NavContext, limit = 3): Suggestion[] {
  const used = new Set(context.recent);
  const candidates: Suggestion[] = [];

  if (!context.providerConfigured) {
    // The only blocking one, and the only one worth showing on its own.
    return [{ command: "/settings", reason: "no model provider is configured yet" }];
  }
  if (context.turns === 0) {
    candidates.push({ command: "/guide", reason: "a short tour, if this is your first session" });
    candidates.push({ command: "/palette", reason: "search every command by what it does" });
  }
  if (context.openFindings !== undefined && context.openFindings > 0 && context.mode !== "defender") {
    candidates.push({ command: "/defender", reason: `${context.openFindings} security finding${context.openFindings === 1 ? "" : "s"} to work through` });
  }
  if (context.changedFiles > 0) {
    candidates.push({ command: "/diff", reason: `${context.changedFiles} file${context.changedFiles === 1 ? "" : "s"} changed and not looked at yet` });
    candidates.push({ command: "/undo", reason: "put the last turn back if it went the wrong way" });
  }
  if (context.mode === "plan" && context.turns > 0) {
    candidates.push({ command: "/build", reason: "the plan is in context — switch to build to apply it" });
  }
  if (context.openTodos > 0) {
    candidates.push({ command: "/todos", reason: `${context.openTodos} item${context.openTodos === 1 ? "" : "s"} still open on the agent's plan` });
  }
  if (context.runningJobs > 0) {
    candidates.push({ command: "/jobs", reason: `${context.runningJobs} job${context.runningJobs === 1 ? "" : "s"} running in the background` });
    if (context.tabs > 1 || context.runningJobs > 1) candidates.push({ command: "/workspace", reason: "watch everything at once on one screen" });
  }
  if (context.sandbox) {
    candidates.push({ command: "/pull", reason: "the work is in a sandbox — copy it here when it is right" });
  }
  if (context.hasSpend && context.turns >= 3) {
    candidates.push({ command: "/cost", reason: "what this session has spent, per turn" });
  }
  if (context.turns >= 2 && context.changedFiles === 0 && context.runningJobs === 0) {
    candidates.push({ command: "/detach", reason: "send long work to the background and keep the prompt" });
  }

  return candidates.filter((suggestion) => !used.has(suggestion.command)).slice(0, Math.max(0, limit));
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

/** One dim line under the prompt: the single most useful thing to do next, and why. */
export function renderNextStep(context: NavContext, style: SectionStyle): string {
  const [next] = suggestNext(context, 1);
  if (!next) return "";
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  return note(clipTo(`${next.command} ${glyphs.middot} ${next.reason}`, Math.max(16, style.width - 4), glyphs), style);
}
