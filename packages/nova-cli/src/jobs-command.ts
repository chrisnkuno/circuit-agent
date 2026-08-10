/**
 * `/jobs`, `/attach`, `/detach` — the command grammar for durable work.
 *
 * Parsing is kept separate from running for the same reason `tabs.ts` and `wander.ts` split the
 * same way: the shape of what someone typed is a pure question with a small number of answers, and
 * testing it should not require a filesystem, a spawned process, or a fake terminal.
 */

export type JobsCommand =
  | { kind: "list" }
  | { kind: "run"; objective: string }
  | { kind: "cancel"; id: string }
  | { kind: "approve"; id: string; decision: "allow" | "allow_always" | "deny" | "deny_always" }
  | { kind: "invalid"; reason: string };

type ApprovalDecision = Extract<JobsCommand, { kind: "approve" }>["decision"];

const APPROVAL_WORDS: Record<string, ApprovalDecision> = {
  allow: "allow",
  yes: "allow",
  y: "allow",
  "allow-always": "allow_always",
  always: "allow_always",
  deny: "deny",
  no: "deny",
  n: "deny",
  "deny-always": "deny_always",
  never: "deny_always",
};

/** Parses `/jobs`, `/jobs run <objective>`, `/jobs cancel <id>`, `/jobs approve <id> [decision]`. */
export function parseJobsCommand(input: string): JobsCommand | null {
  const match = /^\/jobs(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim().replace(/\s+/g, " ");
  if (!rest) return { kind: "list" };

  const [verb, ...words] = rest.split(" ");
  switch (verb.toLowerCase()) {
    case "run":
      return words.length > 0 ? { kind: "run", objective: words.join(" ") } : { kind: "invalid", reason: "Give it something to do: /jobs run <task>" };
    case "cancel":
      return words[0] ? { kind: "cancel", id: words[0] } : { kind: "invalid", reason: "Which job? /jobs cancel <id>" };
    case "approve": case "resolve": case "decide": {
      const id = words[0];
      if (!id) return { kind: "invalid", reason: "Which job? /jobs approve <id> [allow|deny]" };
      const word = (words[1] ?? "allow").toLowerCase();
      const decision = APPROVAL_WORDS[word];
      return decision ? { kind: "approve", id, decision } : { kind: "invalid", reason: `"${words[1]}" is not a decision — try allow, deny, allow-always, or deny-always.` };
    }
    default:
      return { kind: "invalid", reason: `Unknown /jobs command "${verb}". Try run, cancel, or approve.` };
  }
}

export type AttachCommand = { kind: "attach"; id: string } | { kind: "invalid"; reason: string };

/** Parses `/attach <id>`. */
export function parseAttachCommand(input: string): AttachCommand | null {
  const match = /^\/attach(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const id = (match[1] ?? "").trim();
  return id ? { kind: "attach", id } : { kind: "invalid", reason: "Which job? /attach <id> — see /jobs for the list." };
}

export type DetachCommand = { kind: "detach"; objective: string } | { kind: "invalid"; reason: string };

/** Parses `/detach <objective>` — starting new background work while idle at the prompt. */
export function parseDetachCommand(input: string): DetachCommand | null {
  const match = /^\/detach(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const objective = (match[1] ?? "").trim();
  return objective
    ? { kind: "detach", objective }
    : { kind: "invalid", reason: "Give it something to do: /detach <task>. To send the turn that's running right now to the background, press Alt+B instead." };
}
