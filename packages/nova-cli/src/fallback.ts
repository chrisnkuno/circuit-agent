import type { ProviderId } from "@circuit-nova/nova-core/providers/agent-matrix";

export type FallbackPreference =
  | { kind: "off" }
  | { kind: "ask" }
  | { kind: "target"; provider: ProviderId; model: string };

const PROVIDERS = new Set<ProviderId>(["anthropic", "openai", "circuitnotion", "ollama"]);

export function parseFallbackPreference(raw: string | undefined): FallbackPreference | null {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === "off") return { kind: "off" };
  if (value.toLowerCase() === "ask") return { kind: "ask" };
  const match = /^(anthropic|openai|circuitnotion|ollama)[:/]([^\s]+)$/i.exec(value);
  if (!match || !PROVIDERS.has(match[1].toLowerCase() as ProviderId)) return null;
  return { kind: "target", provider: match[1].toLowerCase() as ProviderId, model: match[2] };
}

export function fallbackSetting(preference: FallbackPreference): string | undefined {
  if (preference.kind === "off") return undefined;
  if (preference.kind === "ask") return "ask";
  return `${preference.provider}:${preference.model}`;
}
