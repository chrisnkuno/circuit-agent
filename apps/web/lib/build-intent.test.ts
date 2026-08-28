import { describe, expect, it } from "vitest";
import { detectBuildIntent } from "./build-intent";

describe("build intent", () => {
  it("treats a plain build request as a request to build", () => {
    expect(detectBuildIntent("create a calculator app")).toBe(true);
    expect(detectBuildIntent("Build a responsive inventory dashboard")).toBe(true);
    expect(detectBuildIntent("write me a script that renames files")).toBe(true);
  });

  it("acts on an explicit instruction to stop asking and start", () => {
    expect(detectBuildIntent("simple python app go ahead build it in the sandbox already")).toBe(true);
    expect(detectBuildIntent("go ahead, build it")).toBe(true);
    expect(detectBuildIntent("yes build the app")).toBe(true);
  });

  it("leaves questions about building as conversation", () => {
    expect(detectBuildIntent("can you build apps?")).toBe(false);
    expect(detectBuildIntent("What kind of app should I create?")).toBe(false);
    expect(detectBuildIntent("how do I make a website?")).toBe(false);
  });

  it("does not read ordinary conversation as a build request", () => {
    expect(detectBuildIntent("hello")).toBe(false);
    expect(detectBuildIntent("thanks, that explanation helped")).toBe(false);
    expect(detectBuildIntent("")).toBe(false);
    expect(detectBuildIntent("   ")).toBe(false);
  });
});
