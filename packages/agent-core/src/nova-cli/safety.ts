import type { AgentTool, AgentToolCall } from "../agent-runtime";
import { isFindDelete, isRecursiveForceRemoval } from "./command";

export type SensitiveCategory =
  | "credentials"
  | "destructive"
  | "external"
  | "financial"
  | "privacy"
  | "production"
  | "security";

export type SafetyAssessment = {
  sensitive: boolean;
  categories: SensitiveCategory[];
  reasons: string[];
};

type Rule = { category: SensitiveCategory; reason: string; pattern: RegExp };

const TASK_RULES: Rule[] = [
  // Possessing a credential is not itself a dangerous action. Reading a project-local `.env`, or
  // putting a token the user supplied into that project's configuration, is routine development
  // work. Preflight only the consequences that are hard to undo: disclosure and lifecycle changes.
  // The exact write still passes through the tool-level credential-file approval below.
  { category: "credentials", reason: "credential disclosure or high-impact credential change", pattern: /\b(?:export|expose|reveal|print|show|share|send|upload|publish|rotate|revoke)\b.{0,60}\b(?:api[ _-]?key|api[ _-]?token|access[ _-]?token|auth[ _-]?token|password|private[ _-]?key|secret|credential)s?\b|\b(?:set|add|store|save|replace)\b.{0,45}\b(?:production|prod|live)\b.{0,45}\b(?:api[ _-]?key|api[ _-]?token|access[ _-]?token|auth[ _-]?token|password|private[ _-]?key|secret|credential)s?\b/i },
  // The `rm` branch covers short-flag (`-rf`) and long-flag (`--recursive`, `--force`) spellings
  // separately, in either order, since an objective naming the command at all is worth a preflight
  // confirmation regardless of which GNU flag style it used to say "recursive" or "force". The
  // negative lookbehind excludes `git rm` specifically — an everyday, safe operation (it removes a
  // *tracked* file, recoverable from history) that a bare substring match on "rm -rf" would
  // otherwise flag as if it were the destructive filesystem command.
  { category: "destructive", reason: "destructive data or repository operation", pattern: /(?:(?<!git\s)\brm\s+[^\n]*(?:-[^\n]*[rf]\b|--recursive|--force)|\bfind\s+[^\n]*-delete\b|\b(?:delete|drop|erase|purge|truncate|wipe|destroy|reset)\b.{0,45}\b(?:all|database|table|records?|history|account|branch|repository|production|live)\b)/i },
  { category: "production", reason: "production deployment or release", pattern: /\b(?:deploy|publish|release|promote|roll\s*out|push)\b.{0,45}\b(?:production|prod|live|registry|npm|pypi|app store|play store)\b|\b(?:npm|pnpm|yarn)\s+publish\b/i },
  { category: "financial", reason: "financial transaction", pattern: /\b(?:charge|refund|transfer|withdraw|purchase|pay|payout)\b.{0,45}\b(?:money|funds?|card|customer|account|invoice|payment|subscription|\$|usd|eur|gbp)\b/i },
  { category: "external", reason: "external communication or publication", pattern: /\b(?:send|email|message|post|publish|submit|merge)\b.{0,45}\b(?:customer|user|client|public|email|message|notification|pull request|social|production)\b/i },
  { category: "privacy", reason: "private or regulated personal data", pattern: /\b(?:download|export|share|send|upload|expose|list)\b.{0,45}\b(?:pii|personal data|patient|medical|health record|customer data|user data|social security|passport)\b/i },
  { category: "security", reason: "security or access-control weakening", pattern: /\b(?:bypass|disable|remove|weaken|turn off|skip)\b.{0,45}\b(?:auth|authentication|authorization|approval|permission|mfa|2fa|security|encryption|guard|verification)\b/i },
];

const COMMAND_RULES: Rule[] = [
  // `rm` is deliberately absent here — see isRecursiveForceRemoval below, which checks the actual
  // program being run rather than matching the substring "rm -rf" anywhere, including inside the
  // ordinary and safe `git rm -rf <tracked-file>`.
  { category: "destructive", reason: "destructive shell command", pattern: /\b(?:git\s+(?:reset\s+--hard|clean\s+-[^\n]*f)|drop\s+(?:database|table)|truncate\s+table|kubectl\s+delete|terraform\s+destroy)\b/i },
  // Local reads are intentionally absent. They may expose a value to the model running this
  // session, but they do not alter or transmit it and are a normal part of diagnosing a project.
  // Mutation and likely exfiltration remain explicit decisions.
  { category: "credentials", reason: "command changes or transmits credentials", pattern: /\b(?:secret|secrets)\s+(?:set|put|create|delete)|\b(?:set|export)\s+[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=|\b(?:curl|wget|scp|rsync|nc|netcat|gh\s+gist\s+create)\b[^\n]*(?:\.env(?:\.[^\s]+)?|credentials?|secrets?|\.pem|id_rsa)/i },
  { category: "production", reason: "deployment or package publication command", pattern: /\b(?:npm|pnpm|yarn|bun|uv|poetry|twine|cargo)\s+(?:publish|release)\b|\b(?:vercel(?:\s+deploy)?\s+--prod|(?:fly|railway|render|netlify|firebase)\s+(?:deploy|up|release))|\bkubectl\s+(?:apply|replace|patch|rollout)|\bterraform\s+apply\b|\bgit\s+push\b/i },
  { category: "external", reason: "network mutation or external publication", pattern: /\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bgh\s+pr\s+(?:create|merge|close)|\bgh\s+release\s+create\b/i },
  { category: "security", reason: "privilege or permission change", pattern: /(?:^|[;&|]\s*)sudo\b|\bchmod\s+(?:-R\s+)?777\b|\b(?:disable|bypass)[-_ ]?(?:auth|security)\b/i },
];

const SENSITIVE_PATH = /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.gnupg|credentials?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|id_(?:rsa|ed25519)|[^/\\]*\.pem)$/i;
const PRODUCTION_PATH = /(?:^|[/\\])(?:production|prod)(?:\.[^/\\]+|[/\\]|$)|(?:^|[/\\])(?:vercel|fly|railway|netlify)\.json$/i;
const SECRET_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}/i;

function assess(text: string, rules: readonly Rule[]): SafetyAssessment {
  const matched = rules.filter((rule) => rule.pattern.test(text));
  return {
    sensitive: matched.length > 0,
    categories: [...new Set(matched.map((rule) => rule.category))],
    reasons: [...new Set(matched.map((rule) => rule.reason))],
  };
}

/** Screens a user objective before a model sees it or a tool can be proposed. */
export function assessTaskSafety(objective: string): SafetyAssessment {
  return assess(objective, TASK_RULES);
}

/** Screens the exact tool and arguments before auto mode may take its workspace fast path. */
export function assessToolSafety(call: AgentToolCall, tool: AgentTool): SafetyAssessment {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const findings: Array<{ category: SensitiveCategory; reason: string }> = [];
  const add = (category: SensitiveCategory, reason: string) => findings.push({ category, reason });

  if (tool.effect === "external") add("external", "action affects a system outside the workspace");

  const command = typeof args.command === "string" ? args.command : "";
  for (const reason of assess(command, COMMAND_RULES).reasons) {
    const rule = COMMAND_RULES.find((candidate) => candidate.reason === reason)!;
    add(rule.category, reason);
  }
  // The regex above only recognizes `rm -rf` in that literal short-flag spelling. Reordered
  // (`-fr`), long-form (`--recursive --force`) and `find ... -delete` all bypassed it in a live
  // probe — meaning auto mode would have run any of them with no confirmation at all. Checked by
  // token, not pattern, so flag order and spelling cannot matter to it the way they mattered here.
  if (isRecursiveForceRemoval(command)) add("destructive", "recursive, forced file removal");
  if (isFindDelete(command)) add("destructive", "find with -delete, as thorough a wipe as rm -rf");

  const path = typeof args.path === "string" ? args.path : "";
  if (SENSITIVE_PATH.test(path)) add("credentials", "sensitive credential or environment file");
  if (PRODUCTION_PATH.test(path)) add("production", "production configuration file");

  const content = [args.content, args.replacement, args.newText]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (SECRET_CONTENT.test(content)) add("credentials", "content appears to contain a credential or private key");

  return {
    sensitive: findings.length > 0,
    categories: [...new Set(findings.map((item) => item.category))],
    reasons: [...new Set(findings.map((item) => item.reason))],
  };
}
