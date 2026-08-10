import { describe, expect, it } from "vitest";
import { sanitizeHistory } from "./history";

describe("prompt history", () => {
  it("deduplicates recent prompts and never stores likely credentials", () => {
    expect(sanitizeHistory(["fix tests", "api_key=secret", "fix tests", "ship build", "/settings"]))
      .toEqual(["fix tests", "ship build"]);
  });
});
