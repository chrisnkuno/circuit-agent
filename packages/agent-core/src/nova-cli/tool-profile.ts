/**
 * Intent-aware tool scoping shared by estimation and execution.
 * Conservative defaults preserve capability whenever a request is ambiguous.
 */
import type { NovaMode } from "./permissions";
import type { AgentTool } from "../agent-runtime";

export type ToolProfile = "chat" | "read" | "full";

const MUTATING = /\b(create|write|edit|change|modify|fix|implement|build|install|delete|remove|rename|move|run|test|commit|push|deploy|publish|send|continue|resume)\b/i;
const REPOSITORY_READING = /\b(review|inspect|audit|analy[sz]e|diagnose|explain|find|locate|search|read|why|error|bug|code|repo(?:sitory)?|project|file|folder|function|class|test|diff)\b/i;
const DIRECT_CHAT = /^(?:hi|hello|hey|thanks|thank you|who are you|what can you do)[.!?\s]*$/i;
const EXACT_REPLY = /\b(?:reply|respond|say|output)\s+with\s+(?:exactly|only)\b/i;

/** Conservative intent routing: uncertainty keeps the full toolset. */
export function toolProfileForObjective(objective: string, mode: NovaMode): ToolProfile {
  const text = objective.trim();
  if (mode === "defender" || MUTATING.test(text)) return "full";
  if (DIRECT_CHAT.test(text) || EXACT_REPLY.test(text)) return "chat";
  if (REPOSITORY_READING.test(text)) return "read";
  return "full";
}

export function toolsForProfile(tools: readonly AgentTool[], profile: ToolProfile): AgentTool[] {
  if (profile === "full") return [...tools];
  if (profile === "chat") return [];
  return tools.filter((tool) => tool.effect === "none");
}
