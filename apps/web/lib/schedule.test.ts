import { describe, expect, it } from "vitest";
import { nextCronOccurrence, validateCronExpression } from "./schedule";

describe("connector schedules", () => {
  it("calculates daily occurrences in the user's timezone", () => {
    const after = Date.parse("2026-08-05T03:30:00Z");
    expect(new Date(nextCronOccurrence("0 7 * * *", "Africa/Cairo", after)).toISOString()).toBe("2026-08-05T04:00:00.000Z");
  });

  it("supports bounded interval schedules", () => {
    const after = Date.parse("2026-08-05T10:07:00Z");
    expect(new Date(nextCronOccurrence("*/15 * * * *", "UTC", after)).toISOString()).toBe("2026-08-05T10:15:00.000Z");
  });

  it("rejects malformed cron expressions and timezones", () => {
    expect(validateCronExpression("61 * * * *")).toEqual(["Invalid cron value 61"]);
    expect(() => nextCronOccurrence("0 7 * * *", "Not/AZone", Date.now())).toThrow("timezone");
  });
});
