import {
  defaultSignals,
  shouldOfferStarters,
  starterSuggestions,
  suggest,
  type DesktopActionId,
  type SessionSignals,
  type Suggestion,
  type SuggestionCategory,
} from "@circuit-nova/nova-core/nova-cli/suggestions";
import type { ActivityEntry, ChatState } from "./chat-state";
import { projectName } from "./starters";

/**
 * The window's half of the shared suggestion engine.
 *
 * The rules live in `nova-core` and are the same ones the CLI reads; what lives here is the
 * translation in both directions — this app's scattered state into the signals the rules take, and
 * the rules' abstract actions back into things a window can actually do.
 *
 * The mapping is deliberately the only thing here. Every temptation to add "just one desktop-only
 * rule" is a rule the terminal will never have, and two front ends drifting apart on what they
 * think you should do next is the exact failure the shared engine was written to end.
 */

export type {
  DesktopActionId,
  SessionSignals,
  Suggestion,
  SuggestionCategory,
};

export { shouldOfferStarters, starterSuggestions, suggest };

/** The tools that change files. What "3 files changed" is counted from, since the window is not git. */
const WRITING_TOOLS = new Set(["write_file", "edit_file", "deploy_app"]);

/**
 * How many files this session's work has touched.
 *
 * Counted from the activity log rather than asked of the sidecar, because a suggestion has to be
 * ready at the instant a turn ends and a round trip is not. Distinct summaries stand in for
 * distinct paths — the summary of a write *is* the path — and only successful calls count: an edit
 * that failed changed nothing, and offering to review it would send the reader to an empty diff.
 */
export function changedFileCount(activity: readonly ActivityEntry[]): number {
  const touched = new Set<string>();
  for (const entry of activity) {
    if (!WRITING_TOOLS.has(entry.name) || entry.status !== "ok") continue;
    touched.add(entry.summary ?? entry.id);
  }
  return touched.size;
}

export type DesktopSessionState = {
  chat: ChatState;
  root: string | null;
  mode: SessionSignals["mode"];
  tabs: number;
  sandbox: boolean;
  openTodos: number;
  providerConfigured: boolean;
  busy: boolean;
  /** Suggestion ids already taken this session, most recent first. */
  taken: readonly string[];
  /** Findings the last scan reported, if one has run in this window. */
  openFindings?: number;
};

/** This window's state as the signals the shared rules take. */
export function desktopSignals(state: DesktopSessionState): SessionSignals {
  const { chat } = state;
  return defaultSignals({
    mode: state.mode,
    // The transcript's own count, not the message count: a session that has streamed half an answer
    // has had no turns, and a session opened on a resumed thread has had several.
    turns: chat.turns ?? chat.costTurns?.length ?? 0,
    changedFiles: changedFileCount(chat.activity),
    openTodos: state.openTodos,
    // The window has no background jobs of its own — a tab is how it runs a second thing — so this
    // stays zero rather than pretending, which keeps `/jobs`-shaped advice out of a UI without one.
    runningJobs: 0,
    tabs: state.tabs,
    sandbox: state.sandbox,
    providerConfigured: state.providerConfigured,
    projectOpen: Boolean(state.root),
    hasSpend: Boolean(chat.displayTotal),
    taken: state.taken,
    ...(state.openFindings === undefined ? {} : { openFindings: state.openFindings }),
    ...(chat.budgetFraction === undefined ? {} : { budgetFraction: chat.budgetFraction }),
    ...(chat.lastStatus ? { lastStatus: chat.lastStatus as SessionSignals["lastStatus"] } : {}),
    ...(chat.error ? { lastError: chat.error } : {}),
    ...(state.root ? { projectName: projectName(state.root) } : {}),
  });
}

/**
 * What the chip row under the composer shows.
 *
 * Three at most, because a fourth is where a row of buttons stops being read as advice and starts
 * being read as a toolbar — and a toolbar is something you learn once and then ignore. Nothing at
 * all while a turn is running: the useful next step then is to watch, and a live row of buttons
 * offering to undo work that is still being done is worse than an empty strip.
 */
export function composerSuggestions(state: DesktopSessionState, limit = 3): Suggestion[] {
  if (state.busy) return [];
  return suggest(desktopSignals(state), { surface: "desktop", limit });
}

/**
 * The way out of the error in the notice, as buttons.
 *
 * Only the recovery rules, and only when something actually failed — a "try again" under an error
 * the rules do not recognise is a guess dressed as a diagnosis.
 */
export function recoverySuggestions(state: DesktopSessionState, limit = 2): Suggestion[] {
  if (!state.chat.error) return [];
  return suggest(desktopSignals(state), { surface: "desktop", limit, categories: ["blocked", "recovery"] });
}

/** The starters for an empty transcript, as prompts that fill the composer rather than send. */
export function starters(state: DesktopSessionState): Suggestion[] {
  const signals = desktopSignals(state);
  return shouldOfferStarters(signals, state.busy) ? starterSuggestions(signals) : [];
}
