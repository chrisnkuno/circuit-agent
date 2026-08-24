import { describe, expect, it } from "vitest";
import { defenderFeedKeys, OFFICIAL_DEFENDER_FEED_KEYS, OFFICIAL_DEFENDER_FEED_URL } from "./defender-feed-update";

describe("Defender feed CLI policy", () => {
  it("uses the official HTTPS authority", () => {
    expect(new URL(OFFICIAL_DEFENDER_FEED_URL).protocol).toBe("https:");
    expect(Object.isFrozen(OFFICIAL_DEFENDER_FEED_KEYS)).toBe(true);
    expect(OFFICIAL_DEFENDER_FEED_KEYS).toEqual({
      "release-2026-01": "MCowBQYDK2VwAyEA4/jb1zd6f+jIPAFja1bPNtroXV8MtAZFrKt5BSY+ngI=",
    });
  });

  it("accepts only bounded key-id/string mappings", () => {
    expect(defenderFeedKeys({ NOVA_DEFENDER_BRAIN_PUBLIC_KEYS: JSON.stringify({ "key-1": "public", "bad id": "ignored", huge: "x".repeat(5_000) }) })).toEqual({ "key-1": "public" });
    expect(defenderFeedKeys({ NOVA_DEFENDER_BRAIN_PUBLIC_KEYS: "not json" })).toEqual({});
  });
});
