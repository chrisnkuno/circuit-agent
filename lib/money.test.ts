import { describe, expect, it } from "vitest";
import { countryFromLocale, currencyForCountry, formatConvertedRwf } from "./money";

describe("local money presentation", () => {
  it("maps an automatic locale to its country and currency", () => {
    expect(countryFromLocale("en-GB")).toBe("GB");
    expect(currencyForCountry("GB")).toBe("GBP");
  });

  it("converts from the authoritative RWF ledger before formatting", () => {
    expect(formatConvertedRwf(1_000, "USD", 0.0007, "en-US")).toBe("$0.70");
  });

  it("fails safely back to RWF when an exchange rate is unavailable", () => {
    expect(formatConvertedRwf(1_000, "USD", null, "en-US")).toMatch(/^RWF/);
  });
});
