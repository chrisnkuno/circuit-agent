import { describe, expect, it } from "vitest";
import { buildMultiAppWorkflow, readyIntents, validateMultiAppWorkflow } from "./multitasker";

describe("multi-app workflows", () => {
  it("coordinates several apps as one dependency graph", () => {
    const workflow = buildMultiAppWorkflow("meeting-follow-up", "flow-1");
    expect(workflow.intents.map((item) => item.connectorId)).toEqual(["google-calendar", "gmail", "todoist", "gmail"]);
    expect(workflow.intents.find((item) => item.key === "send")).toMatchObject({ status: "awaiting_approval", requiresApproval: true, permission: "execute" });
    expect(readyIntents(workflow).map((item) => item.key)).toEqual(["calendar"]);
  });

  it("allows independent reads to proceed in parallel", () => {
    const workflow = buildMultiAppWorkflow("project-update", "flow-2");
    expect(readyIntents(workflow).map((item) => item.key)).toEqual(["notes", "files"]);
  });

  it("does not schedule a consequential action while approval is pending", () => {
    const workflow = buildMultiAppWorkflow("evening-routine", "flow-3");
    workflow.intents.find((item) => item.key === "tomorrow")!.status = "completed";
    workflow.intents.find((item) => item.key === "home")!.status = "completed";
    expect(readyIntents(workflow)).toEqual([]);
    workflow.intents.find((item) => item.key === "routine")!.status = "approved";
    expect(readyIntents(workflow).map((item) => item.key)).toEqual(["routine"]);
  });

  it("rejects unknown dependencies and cycles", () => {
    const workflow = buildMultiAppWorkflow("inbox-to-plan", "flow-4");
    workflow.intents[0].dependsOn = ["missing"];
    expect(validateMultiAppWorkflow(workflow)).toContain("inbox has unknown dependency missing");
    workflow.intents[0].dependsOn = ["tasks"];
    expect(validateMultiAppWorkflow(workflow)).toContain("intent graph contains a cycle");
  });
});
