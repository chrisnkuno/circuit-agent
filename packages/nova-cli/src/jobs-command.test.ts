import { describe, expect, it } from "vitest";
import { parseAttachCommand, parseDetachCommand, parseJobsCommand } from "./jobs-command";

describe("/jobs", () => {
  it("lists with no arguments", () => {
    expect(parseJobsCommand("/jobs")).toEqual({ kind: "list" });
    expect(parseJobsCommand("/jobs   ")).toEqual({ kind: "list" });
  });

  it("reads run with a multi-word objective", () => {
    expect(parseJobsCommand("/jobs run  fix   the failing   tests ")).toEqual({ kind: "run", objective: "fix the failing tests" });
  });

  it("reads cancel", () => {
    expect(parseJobsCommand("/jobs cancel job-1")).toEqual({ kind: "cancel", id: "job-1" });
  });

  it("reads approve with every decision word, and defaults to allow", () => {
    expect(parseJobsCommand("/jobs approve job-1")).toEqual({ kind: "approve", id: "job-1", decision: "allow" });
    expect(parseJobsCommand("/jobs approve job-1 yes")).toEqual({ kind: "approve", id: "job-1", decision: "allow" });
    expect(parseJobsCommand("/jobs approve job-1 always")).toEqual({ kind: "approve", id: "job-1", decision: "allow_always" });
    expect(parseJobsCommand("/jobs approve job-1 no")).toEqual({ kind: "approve", id: "job-1", decision: "deny" });
    expect(parseJobsCommand("/jobs approve job-1 never")).toEqual({ kind: "approve", id: "job-1", decision: "deny_always" });
    expect(parseJobsCommand("/jobs decide job-1 deny")).toEqual({ kind: "approve", id: "job-1", decision: "deny" });
  });

  it("explains what it did not understand, without guessing", () => {
    expect(parseJobsCommand("/jobs run")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("Give it something to do") });
    expect(parseJobsCommand("/jobs cancel")).toMatchObject({ kind: "invalid" });
    expect(parseJobsCommand("/jobs approve")).toMatchObject({ kind: "invalid" });
    expect(parseJobsCommand("/jobs approve job-1 maybe")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("not a decision") });
    expect(parseJobsCommand("/jobs sideways")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("sideways") });
  });

  it("is not a /jobs command", () => {
    expect(parseJobsCommand("/job")).toBeNull();
    expect(parseJobsCommand("/jobsy")).toBeNull();
  });
});

describe("/attach", () => {
  it("reads the job id", () => {
    expect(parseAttachCommand("/attach job-42")).toEqual({ kind: "attach", id: "job-42" });
  });

  it("asks which job when none is given", () => {
    expect(parseAttachCommand("/attach")).toMatchObject({ kind: "invalid" });
  });

  it("is not an /attach command", () => {
    expect(parseAttachCommand("/attachment")).toBeNull();
  });
});

describe("/detach", () => {
  it("reads a new background objective", () => {
    expect(parseDetachCommand("/detach write release notes")).toEqual({ kind: "detach", objective: "write release notes" });
  });

  it("points at the live-turn shortcut when nothing is given", () => {
    // /detach with no argument is genuinely ambiguous — did they mean a new task, or the turn
    // that's running right now? The message has to disambiguate rather than guess.
    expect(parseDetachCommand("/detach")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("Alt+B") });
  });

  it("is not a /detach command", () => {
    expect(parseDetachCommand("/detached")).toBeNull();
  });
});
