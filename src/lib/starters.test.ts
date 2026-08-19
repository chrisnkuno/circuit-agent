import { describe, expect, it } from "vitest";
import { projectName } from "./starters";

describe("naming the project", () => {
  it("uses the last segment of a POSIX path", () => {
    expect(projectName("/home/chris/circuit-agent")).toBe("circuit-agent");
  });

  it("uses the last segment of a Windows path, wherever the session was opened from", () => {
    expect(projectName("C:\\work\\api")).toBe("api");
  });

  it("ignores a trailing separator rather than reporting an empty name", () => {
    expect(projectName("/work/api/")).toBe("api");
    expect(projectName("C:\\work\\api\\")).toBe("api");
  });

  it("falls back to the path itself when there is no segment to take", () => {
    expect(projectName("/")).toBe("/");
  });
});
