import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS } from "./glyphs";
import {
  PACE_PROFILES,
  applyPacing,
  describePace,
  exceedsPace,
  paceBadge,
  parsePaceCommand,
  parsePaceFlag,
  remainingCooldown,
} from "./pacing";
import type { SectionStyle } from "./sections";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const style: SectionStyle = { width: 72, depth: "none" };

describe("the profiles", () => {
  it("gets stricter, never looser, as the level rises — the property the whole feature rests on", () => {
    const gentle = PACE_PROFILES.gentle.budgets;
    const strict = PACE_PROFILES.strict.budgets;
    expect(strict.maxIterations!).toBeLessThan(gentle.maxIterations!);
    expect(strict.maxToolCallsPerTurn!).toBeLessThanOrEqual(gentle.maxToolCallsPerTurn!);
    expect(strict.maxOutputTokens!).toBeLessThan(gentle.maxOutputTokens!);
    expect(PACE_PROFILES.strict.cooldownMs).toBeGreaterThanOrEqual(PACE_PROFILES.gentle.cooldownMs);
    expect(PACE_PROFILES.strict.confirmAboveTokens!).toBeLessThan(PACE_PROFILES.gentle.confirmAboveTokens!);
  });

  it("changes nothing when it is off, so the feature is genuinely opt-in", () => {
    expect(PACE_PROFILES.off.budgets).toEqual({});
    expect(PACE_PROFILES.off.cooldownMs).toBe(0);
    expect(exceedsPace("off", { inputTokensHigh: 10_000_000, outputTokensHigh: 10_000_000 })).toBe(false);
    expect(remainingCooldown("off", 0, 1)).toBe(0);
    expect(paceBadge("off")).toBe("");
  });
});

describe("applying a pace to the runtime's budgets", () => {
  it("keeps the caller's own limits and adds its own", () => {
    const applied = applyPacing({ maxRwf: 5_000 }, "gentle");
    expect(applied.maxRwf).toBe(5_000);
    expect(applied.maxIterations).toBe(PACE_PROFILES.gentle.budgets.maxIterations);
  });

  it("leaves an approved cap exactly as it was — slowing down must never raise a ceiling", () => {
    for (const level of ["off", "gentle", "strict"] as const) {
      expect(applyPacing({ maxRwf: 1_234 }, level).maxRwf).toBe(1_234);
    }
  });
});

describe("the cooldown", () => {
  it("is owed in full right after a turn and nothing at all once it has elapsed", () => {
    const cooldown = PACE_PROFILES.strict.cooldownMs;
    expect(remainingCooldown("strict", 1_000, 1_000)).toBe(cooldown);
    expect(remainingCooldown("strict", 1_000, 1_000 + cooldown)).toBe(0);
    expect(remainingCooldown("strict", 1_000, 1_000 + cooldown * 3)).toBe(0);
  });

  it("owes nothing before the first turn of a session", () => {
    expect(remainingCooldown("strict", undefined)).toBe(0);
  });
});

describe("confirming an expensive turn", () => {
  it("measures the high end of the forecast, which is the case worth asking about", () => {
    const ceiling = PACE_PROFILES.gentle.confirmAboveTokens!;
    expect(exceedsPace("gentle", { inputTokensHigh: ceiling, outputTokensHigh: 1 })).toBe(true);
    expect(exceedsPace("gentle", { inputTokensHigh: 10, outputTokensHigh: 10 })).toBe(false);
  });

  it("asks sooner the stricter the pace", () => {
    const forecast = { inputTokensHigh: 30_000, outputTokensHigh: 0 };
    expect(exceedsPace("strict", forecast)).toBe(true);
    expect(exceedsPace("gentle", forecast)).toBe(false);
  });
});

describe("the grammar", () => {
  it("reads the flag's spellings, and rejects a word it does not know", () => {
    expect(parsePaceFlag("strict")).toBe("strict");
    expect(parsePaceFlag("on")).toBe("gentle");
    expect(parsePaceFlag("off")).toBe("off");
    expect(parsePaceFlag("sideways")).toBeUndefined();
    expect(parsePaceFlag(undefined)).toBeUndefined();
  });

  it("turns a bare /slow on when it is off, and reports when it is already on", () => {
    expect(parsePaceCommand("/slow", "off")).toEqual({ kind: "set", level: "gentle" });
    expect(parsePaceCommand("/slow", "gentle")).toEqual({ kind: "show" });
  });

  it("sets an explicit level either way", () => {
    expect(parsePaceCommand("/slow strict", "off")).toEqual({ kind: "set", level: "strict" });
    expect(parsePaceCommand("/pace off", "strict")).toEqual({ kind: "set", level: "off" });
  });

  it("explains a level it does not recognise", () => {
    const parsed = parsePaceCommand("/slow sideways", "off");
    expect(parsed?.kind).toBe("invalid");
    expect(parsed && "reason" in parsed && parsed.reason).toContain("sideways");
  });

  it("ignores anything that is not the command", () => {
    expect(parsePaceCommand("/slowly", "off")).toBeNull();
    expect(parsePaceCommand("slow down", "off")).toBeNull();
  });
});

describe("what the user is shown", () => {
  it("names every limit the pace imposes, so it is a decision rather than a mood", () => {
    const rendered = plain(describePace("strict", style));
    expect(rendered).toContain("model rounds");
    expect(rendered).toContain("tools per round");
    expect(rendered).toContain("pause between turns");
    expect(rendered).toContain("/slow off");
  });

  it("says only what off means, since there is nothing to list", () => {
    const rendered = plain(describePace("off", style));
    expect(rendered).not.toContain("model rounds");
    expect(rendered.split("\n")).toHaveLength(1);
  });

  it("badges without a character the terminal cannot draw", () => {
    expect(paceBadge("gentle", ASCII_GLYPHS)).toMatch(/^[\x00-\x7f]+$/);
  });
});
