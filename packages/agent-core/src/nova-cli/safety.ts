import type { AgentTool, AgentToolCall } from "../agent-runtime";

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
  { category: "credentials", reason: "credentials or secrets", pattern: /\b(?:set|add|store|save|copy|export|expose|reveal|rotate|revoke|replace|use)\b.{0,45}\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|private[ _-]?key|secret|credential)s?\b/i },
  { category: "destructive", reason: "destructive data or repository operation", pattern: /(?:\brm\s+-[^\n]*[rf]|\b(?:delete|drop|erase|purge|truncate|wipe|destroy|reset)\b.{0,45}\b(?:all|database|table|records?|history|account|branch|repository|production|live)\b)/i },
  { category: "production", reason: "production deployment or release", pattern: /\b(?:deploy|publish|release|promote|roll\s*out|push)\b.{0,45}\b(?:production|prod|live|registry|npm|pypi|app store|play store)\b|\b(?:npm|pnpm|yarn)\s+publish\b/i },
  { category: "financial", reason: "financial transaction", pattern: /\b(?:charge|refund|transfer|withdraw|purchase|pay|payout)\b.{0,45}\b(?:money|funds?|card|customer|account|invoice|payment|subscription|\$|usd|eur|gbp)\b/i },
  { category: "external", reason: "external communication or publication", pattern: /\b(?:send|email|message|post|publish|submit|merge)\b.{0,45}\b(?:customer|user|client|public|email|message|notification|pull request|social|production)\b/i },
  { category: "privacy", reason: "private or regulated personal data", pattern: /\b(?:download|export|share|send|upload|expose|list)\b.{0,45}\b(?:pii|personal data|patient|medical|health record|customer data|user data|social security|passport)\b/i },
  { category: "security", reason: "security or access-control weakening", pattern: /\b(?:bypass|disable|remove|weaken|turn off|skip)\b.{0,45}\b(?:auth|authentication|authorization|approval|permission|mfa|2fa|security|encryption|guard|verification)\b/i },
];

const COMMAND_RULES: Rule[] = [
  { category: "destructive", reason: "destructive shell command", pattern: /\b(?:rm\s+-[^\n]*[rf]|git\s+(?:reset\s+--hard|clean\s+-[^\n]*f)|drop\s+(?:database|table)|truncate\s+table|kubectl\s+delete|terraform\s+destroy)\b/i },
  { category: "credentials", reason: "command reads or changes credentials", pattern: /\b(?:printenv|env|cat|type|more)\b[^\n]*(?:\.env|credentials?|secrets?|\.pem|id_rsa)|\b(?:secret|secrets)\s+(?:set|put|create|delete)|\b(?:set|export)\s+[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=/i },
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
