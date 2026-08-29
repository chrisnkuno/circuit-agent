import { describe, expect, it } from "vitest";
import { acceptsProposal, detectBuildIntent, proposesBuild, resolveBuildRequest } from "./build-intent";

describe("detectBuildIntent", () => {
  it("treats a plain request for software as the request itself", () => {
    expect(detectBuildIntent("Build me a responsive dashboard for release checks")).toBe(true);
    expect(detectBuildIntent("create a small api with four endpoints")).toBe(true);
    expect(detectBuildIntent("spin up a cli tool that renames files")).toBe(true);
  });

  it("leaves a question a question", () => {
    expect(detectBuildIntent("Can you build an app like this?")).toBe(false);
    expect(detectBuildIntent("What would it cost to make a dashboard?")).toBe(false);
  });

  it("accepts an unambiguous instruction without an artifact noun", () => {
    expect(detectBuildIntent("just do it, build the thing")).toBe(true);
    expect(detectBuildIntent("go ahead and make the app")).toBe(true);
  });

  it("does not fire on discussion that merely names software", () => {
    expect(detectBuildIntent("the api is slow today")).toBe(false);
    expect(detectBuildIntent("thanks, that helps")).toBe(false);
  });
});

describe("proposesBuild", () => {
  it("recognises Nova putting a concrete build on the table", () => {
    // Verbatim from the exchange that failed: Nova proposed and quoted, and nothing started.
    expect(proposesBuild("I’ll build a small FastAPI in-memory notes API with GET, POST, PUT, and DELETE endpoints. Estimated sandbox quote: $0.02.")).toBe(true);
    expect(proposesBuild("I will create a responsive status page for you.")).toBe(true);
    expect(proposesBuild("Let me scaffold that service.")).toBe(true);
  });

  it("does not treat ordinary conversation as a proposal", () => {
    expect(proposesBuild("That endpoint returns 404 because the route is missing.")).toBe(false);
    expect(proposesBuild("")).toBe(false);
    expect(proposesBuild(undefined)).toBe(false);
  });
});

describe("acceptsProposal", () => {
  it("reads a short yes as a yes", () => {
    for (const reply of ["go ahead and start", "yes", "yep", "ok", "sure", "do it", "go for it", "please do", "ship it", "let's go"]) {
      expect(acceptsProposal(reply), reply).toBe(true);
    }
  });

  it("does not read a redirection as agreement", () => {
    // These all begin like a yes and then change the request, which is not consent to spend.
    for (const reply of ["no, not that one", "wait, use Django instead", "ok but stop and explain first", "actually, do a CLI"]) {
      expect(acceptsProposal(reply), reply).toBe(false);
    }
  });

  it("is anchored to the start, so a word inside a sentence is not agreement", () => {
    expect(acceptsProposal("going through the options again would help")).toBe(false);
    expect(acceptsProposal("the start button did nothing")).toBe(false);
  });

  it("ignores anything long enough to be a new instruction", () => {
    expect(acceptsProposal(`yes ${"and also ".repeat(40)}`)).toBe(false);
  });
});

describe("resolveBuildRequest", () => {
  it("starts the work when a short yes accepts what Nova just proposed", () => {
    // The whole point: neither message carries the request alone.
    const proposal = "I’ll build a small FastAPI in-memory notes API with GET, POST, PUT, and DELETE endpoints. Estimated sandbox quote: $0.02.";
    const resolved = resolveBuildRequest({ message: "go ahead and start", priorNovaMessage: proposal });
    expect(resolved).toEqual({ objective: proposal, from: "acceptance" });
  });

  it("quotes the person's own words when they asked outright", () => {
    const resolved = resolveBuildRequest({ message: "Build a dashboard with three release checks", priorNovaMessage: "Hello." });
    expect(resolved).toEqual({ objective: "Build a dashboard with three release checks", from: "message" });
  });

  it("needs an actual proposal before a yes means anything", () => {
    // "yes" answering a clarifying question must not spend money.
    expect(resolveBuildRequest({ message: "yes", priorNovaMessage: "Do you want me to explain how sandboxes are billed?" })).toBeNull();
    expect(resolveBuildRequest({ message: "go ahead" })).toBeNull();
  });

  it("stays silent on ordinary conversation", () => {
    expect(resolveBuildRequest({ message: "thanks!", priorNovaMessage: "I’ll build a notes API." })).toBeNull();
    expect(resolveBuildRequest({ message: "   " })).toBeNull();
  });
});
