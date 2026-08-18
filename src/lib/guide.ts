import { SHORTCUTS, type ShortcutAction } from "./shortcuts";

/**
 * The manual, inside the window it documents.
 *
 * The CLI grew a `/guide` for a reason that applies here more strongly, not less: a guide you have
 * to leave the app to read is a guide read once, if at all. Nothing in the window said that tabs
 * really do run at the same time, that a sandboxed session's files never touch this machine, or
 * that Escape denies an approval rather than dismissing it — all things people otherwise learn by
 * being surprised.
 *
 * Two rules keep it honest, both borrowed from the CLI's guide:
 *
 * - **It is data, not prose in a component.** Topics can then be searched, linked and tested.
 * - **It cannot go stale quietly.** Every keyboard shortcut the window offers must be named by some
 *   topic, and every shortcut a topic claims must exist. Adding a shortcut without documenting it
 *   fails the suite, which is the only mechanism that has ever kept documentation current.
 */

export type GuideTopic = {
  id: string;
  title: string;
  /** One sentence, shown in the index beside the title. */
  summary: string;
  /** The body, as paragraphs. */
  body: string[];
  /** Shortcuts this topic explains — rendered with their keys, and checked against `SHORTCUTS`. */
  shortcuts?: readonly ShortcutAction[];
};

export const GUIDE: readonly GuideTopic[] = [
  {
    id: "start",
    title: "Getting started",
    summary: "A key, a folder, and a first request.",
    body: [
      "Nova needs one thing before it can work: an API key, pasted into Settings. Everything else on that screen — base URL, budget, sandbox, relay — has a working default. Test this key checks the credentials against the provider's model list before you commit to them; it is an authenticated call that generates no tokens, so it costs nothing.",
      "Then open a folder. Nova works inside a project: type a path and press Open, or use Browse to pick one. The folder you choose is the boundary for everything that follows — the agent reads, writes and runs commands there, and files it creates land in that folder on this machine.",
      "Type what you want in the box at the bottom and send. Nova reports what it actually did rather than what it intended: a write is shown as a write, a command with its exit code, and a turn that changed files without running anything is reported as needing verification rather than as finished.",
    ],
    shortcuts: ["send", "focus-composer", "settings"],
  },
  {
    id: "modes",
    title: "Modes: how much Nova may do by itself",
    summary: "Plan, Build, Auto and Defender, from cannot-write to security review.",
    body: [
      "Plan cannot write. The write and command tools are not offered to the model at all, so this is a capability boundary rather than an instruction it has been asked to respect.",
      "Build asks before every edit and every command. Auto applies ordinary edits to the project without asking, but still stops for anything sensitive — credential files, secret-like content, production configuration, destructive or privileged commands, deploys, publishes, pushes and network changes.",
      "Defender turns Nova into a security reviewer with the full tool set to actually run a scanner and propose a fix, gated exactly like Build so nothing is applied without you. It works from a bundled, OWASP-aligned set of playbooks.",
      "The mode is per tab. A tab grinding through a test suite can sit in Auto while the tab touching your deployment config stays in Build.",
    ],
    shortcuts: ["plan", "build", "auto", "defender"],
  },
  {
    id: "approvals",
    title: "Approvals",
    summary: "What the dialog is asking, and why Enter cannot answer it.",
    body: [
      "When Nova wants to do something the current mode does not cover, it stops and shows you the exact command or the exact file. Answer with Y to allow it, N to refuse it, A to allow this precise action from now on, or D to refuse it from now on. A and D are remembered for that exact action only — approving one command does not approve a family of them.",
      "The dialog deliberately has no default button. Focus lands on the dialog itself, so Enter — the key people press to make things go away — cannot approve a command. Escape denies rather than merely closing, because a dialog that vanishes while the agent is still waiting is a hang with no visible cause.",
      "A tool that did not ship with Nova always says where it came from, so a tool called deploy from an MCP server can never be mistaken for one of Nova's own.",
      "Worth being plain about: on this machine there is no sandbox around an approved command. It runs with exactly the authority your own shell has. The approval prompt is the boundary — which is why it shows you the exact command. When you want a real one, use a sandbox.",
    ],
  },
  {
    id: "tabs",
    title: "Tabs, running at the same time",
    summary: "Several pieces of work in one window, genuinely in parallel.",
    body: [
      "Each tab keeps its own conversation, project, model, mode and cost. Unlike the terminal's tabs, these really do run at once: turns are serialised per session rather than globally, so a turn in one tab runs while another streams.",
      "The strip says which tabs are working, which one is blocked on an approval, and what finished while you were looking somewhere else — the whole point of a background tab being that you are not watching it.",
      "Files stay with their own project. Two tabs open on two folders write into two folders; neither can put its work in the other's repository.",
    ],
    shortcuts: ["tab-new", "tab-close", "tab-next", "tab-previous", "tab-select-1"],
  },
  {
    id: "files",
    title: "The project's files",
    summary: "Browse, read and mention a file without leaving the window.",
    body: [
      "The explorer lists the project as a tree you can expand, and typing searches flat across the whole project — a match three folders deep is not made easier to find by nesting it three folders deep.",
      "Selecting a file reads it into the pane beside the tree, so you can check what the agent wrote without opening an editor. Mentioning is a separate, deliberate act: reading a file to decide whether it is the one you meant should not put it into your next message. Mention in composer inserts an @path, which is the same syntax the agent already understands.",
      "The contents come from the session's own workspace, never from the disk directly. For a sandboxed tab that means you are shown the sandbox's copy — the file the agent is actually working on, rather than a stale one with the same name on this machine.",
    ],
    shortcuts: ["files"],
  },
  {
    id: "where",
    title: "Where the work happens",
    summary: "Your machine, or a sandbox that never touches it.",
    body: [
      "By default Nova works on this machine, in the folder you opened. Files it creates are real files in that folder, and an approved command runs as you.",
      "Turn on Sandbox and the work moves to a disposable remote machine instead. Files exist only there, so nothing can touch your working tree; Pull files copies results back when you want them. A sandbox needs an E2B key in Settings, and if it cannot be created the session fails rather than quietly falling back to your own disk — which would do the one thing the toggle exists to prevent.",
    ],
  },
  {
    id: "changes",
    title: "Seeing changes, and undoing them",
    summary: "What moved on disk, and how to put it back.",
    body: [
      "Changes shows what has moved in the project since the last checkpoint, so a turn's claims can be checked against the files themselves.",
      "Every turn snapshots the project into a private git index first. Undo reverts the files a turn modified and removes the ones it created, without touching anything you had staged yourself.",
      "Stop ends the turn in progress. It stops only the tab you asked about — a stop button that reached across tabs would end work you can see running somewhere else on screen.",
    ],
    shortcuts: ["diff", "undo", "stop"],
  },
  {
    id: "models",
    title: "Models and what they cost",
    summary: "Switch model mid-conversation; see the price before you do.",
    body: [
      "The button in the top bar is both the readout and the control: it says which model this tab is on, and opens the picker. Each row carries that model's list price, and switching keeps the conversation — the transcript carries across.",
      "Models from providers you have no key for are listed rather than hidden, because holding one provider's credentials at a time is normal and switching provider is a legitimate thing to do from here. A menu that hid the rest would look like the app supported only one.",
      "Cost is reported honestly. Sub-cent amounts are shown as real numbers rather than rounded to zero, and a model with no published rate says cost unknown instead of inventing one. Prices are list rates, not your contract.",
    ],
    shortcuts: ["models"],
  },
  {
    id: "scan",
    title: "Scanning for secrets",
    summary: "A deterministic check for hardcoded credentials, worst first.",
    body: [
      "Scan reads the working tree for things shaped like credentials — keys, tokens, private key blocks — and ranks what it finds by consequence: critical, then high, then medium. Matched values are always masked.",
      "It is deterministic and read-only, so it costs nothing: no model turn, no approval. A pattern match is a lead rather than proof, which is why the results say so — a test fixture and a live production key look identical to a regular expression.",
    ],
  },
  {
    id: "sessions",
    title: "Sessions and memory",
    summary: "Work you can come back to, and facts Nova keeps.",
    body: [
      "Every conversation is saved in the project under .nova, in the same format the CLI uses — the same sessions, not a desktop-only copy. The sessions list shows what this project already has; picking one resumes it.",
      "Memory is separate from history and deliberately smaller: durable facts in plain markdown you can read, edit, commit or delete. Project knowledge lives with the project; personal preferences live with your settings.",
    ],
  },
  {
    id: "keys",
    title: "Every keyboard shortcut",
    summary: "The whole list, in one place.",
    body: [
      "Every shortcut carries a modifier, because the composer is the main thing on screen and a bare letter has to stay a letter. Escape is the exception, and only when you are not typing: stopping a runaway turn is the one action that must never require aiming.",
      "On macOS, Command works wherever Ctrl is listed.",
    ],
    shortcuts: SHORTCUTS.map((binding) => binding.action),
  },
];

export function findGuideTopic(id: string): GuideTopic | undefined {
  return GUIDE.find((topic) => topic.id === id);
}

/** The chord for an action, as the guide should print it. */
export function keysFor(action: ShortcutAction): string | undefined {
  return SHORTCUTS.find((binding) => binding.action === action)?.keys;
}

/**
 * Topics matching a query, by title, summary or body.
 *
 * Substring rather than fuzzy: this index is a dozen entries, and a search that surprises you on a
 * list you can see all of is worse than one that finds nothing.
 */
export function searchGuide(query: string): readonly GuideTopic[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return GUIDE;
  return GUIDE.filter((topic) =>
    topic.title.toLowerCase().includes(needle) ||
    topic.summary.toLowerCase().includes(needle) ||
    topic.body.some((paragraph) => paragraph.toLowerCase().includes(needle)),
  );
}
