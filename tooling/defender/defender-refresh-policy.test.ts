import { describe, expect, it } from "vitest";
import { allowedResearchUrl } from "./defender-refresh-policy";

describe("Defensive Brain research allowlist", () => {
  it("accepts exact hosts and their subdomains, but not suffix lookalikes", () => {
    expect(allowedResearchUrl("https://www.nist.gov/pqc", ["nist.gov"])).toBe(true);
    expect(allowedResearchUrl("https://pages.nist.gov/project", ["nist.gov"])).toBe(true);
    expect(allowedResearchUrl("https://nist.gov.attacker.example/pqc", ["nist.gov"])).toBe(false);
  });

  it("honours organization path constraints case-insensitively", () => {
    expect(allowedResearchUrl("https://github.com/mandiant/capa/releases", ["github.com/mandiant"])).toBe(true);
    expect(allowedResearchUrl("https://github.com/MANDIANT", ["github.com/mandiant"])).toBe(true);
    expect(allowedResearchUrl("https://github.com/untrusted/capa", ["github.com/mandiant"])).toBe(false);
  });

  it("rejects non-HTTPS and malformed URLs", () => {
    expect(allowedResearchUrl("http://nist.gov/pqc", ["nist.gov"])).toBe(false);
    expect(allowedResearchUrl("not a url", ["nist.gov"])).toBe(false);
  });
});
