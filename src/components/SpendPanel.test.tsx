import { describe, expect, it } from "vitest";
import { describeAge, formatMinutes, formatRate } from "./SpendPanel";

describe("rate formatting", () => {
  it("never reports a paid turn as free", () => {
    // RWF has no minor unit, so whole-unit rounding turns a real sub-unit rate into "RWF 0" —
    // a panel telling someone their paid turn cost nothing.
    expect(formatRate(400_000, "RWF")).not.toBe("RWF 0");
    expect(formatRate(400_000, "RWF")).toBe("RWF 0.4");
  });

  it("keeps whole RWF whole", () => {
    expect(formatRate(1_500_000_000, "RWF")).toBe("RWF 1,500");
  });

  it("shows a genuine zero as zero", () => {
    expect(formatRate(0, "RWF")).toBe("RWF 0");
  });

  it("gives a small foreign rate enough digits to mean something", () => {
    expect(formatRate(1_200, "USD")).toBe("USD 0.0012");
  });
});

describe("duration formatting", () => {
  it("speaks in the units people use", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(130)).toBe("2 h 10 min");
  });
});

describe("balance age", () => {
  it("says when the figure was read, because a balance is a fact about a moment", () => {
    expect(describeAge(0)).toBe("checked just now");
    expect(describeAge(59_000)).toBe("checked just now");
    expect(describeAge(4 * 60_000)).toBe("checked 4 min ago");
    expect(describeAge(3 * 60 * 60_000)).toBe("checked 3 h ago");
  });

  it("never reports a negative age from a clock that disagrees with the gateway", () => {
    // The gateway stamps `asOf` on its own clock; a desktop running a minute behind would
    // otherwise render "checked -1 min ago".
    expect(describeAge(-90_000)).toBe("checked just now");
  });
});
