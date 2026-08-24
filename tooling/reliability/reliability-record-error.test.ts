import { describe, expect, it } from "vitest";

import { sanitizeErrorField } from "./reliability-record-error";

describe("reliability error evidence", () => {
  it("keeps classifications useful without accepting arbitrary log content", () => {
    expect(sanitizeErrorField("free model / north mini (exit 1)")).toBe(
      "free-model-/-north-mini--exit-1-",
    );
  });

  it("bounds public error fields", () => {
    expect(sanitizeErrorField("x".repeat(200))).toHaveLength(160);
  });
});
