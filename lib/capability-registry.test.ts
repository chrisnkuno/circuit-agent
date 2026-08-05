import { describe, expect, it } from "vitest";
import { CapabilityRegistry, capabilityRegistry, validateCapabilityManifests, type CapabilityManifest } from "./capability-registry";

describe("capability registry", () => {
  it("keeps the core narrow and loads task-specific capabilities on demand", () => {
    expect(capabilityRegistry.defaultsFor("coding").map((item) => item.id)).toEqual([
      "reasoning.plan",
      "workspace.files",
      "workspace.terminal",
    ]);
    expect(capabilityRegistry.defaultsFor("research").map((item) => item.id)).toEqual([
      "reasoning.plan",
      "web.research",
      "document.compose",
    ]);
    expect(capabilityRegistry.list().filter((item) => item.layer === "core")).toHaveLength(3);
  });

  it("fails closed for unknown or incompatible requested capabilities", () => {
    expect(() => capabilityRegistry.resolve("writing", ["workspace.terminal"])).toThrow("does not support writing");
    expect(() => capabilityRegistry.resolve("coding", ["missing.tool"])).toThrow("Unknown capability");
  });

  it("reports configuration gates without exposing configuration values", () => {
    const availability = capabilityRegistry.availability("operations", []);
    expect(availability.find((item) => item.capability.id === "operations.execute")).toMatchObject({
      available: false,
      missingConfiguration: ["CONNECTOR_RUNTIME_URL", "CONNECTOR_RUNTIME_TOKEN"],
    });
  });

  it("rejects unsafe external capabilities without approval", () => {
    const unsafe: CapabilityManifest = {
      id: "mail.send",
      label: "Send mail",
      description: "Send an external message.",
      layer: "connector",
      taskKinds: ["operations"],
      runtime: "external",
      risk: "external_action",
      defaultFor: [],
      requiresApproval: false,
      requiredConfiguration: [],
    };
    expect(validateCapabilityManifests([unsafe])).toEqual([
      "external capability mail.send must require approval",
      "connector mail.send must declare configuration gates",
    ]);
    expect(() => new CapabilityRegistry([unsafe])).toThrow("Invalid capability registry");
  });
});
