import { describe, expect, it } from "vitest";
import { isAuthorized } from "./index";

describe("isAuthorized", () => {
  it("accepts only an exact match of the configured secret", () => {
    expect(isAuthorized("correct-secret", "correct-secret")).toBe(true);
  });

  it("rejects a missing, wrong, or empty-string secret", () => {
    expect(isAuthorized(null, "correct-secret")).toBe(false);
    expect(isAuthorized("wrong-secret", "correct-secret")).toBe(false);
    expect(isAuthorized("", "correct-secret")).toBe(false);
  });

  it("never authorizes when the Worker itself has no secret configured", () => {
    expect(isAuthorized("anything", "")).toBe(false);
    expect(isAuthorized(null, "")).toBe(false);
  });
});
