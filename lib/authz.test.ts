import { describe, expect, it } from "vitest";
import { hasPermission, requirePermission, requireSameOrganization } from "./authz";

describe("organization authorization", () => {
  it("keeps viewer access read-only", () => {
    expect(hasPermission("viewer", "task:read")).toBe(true);
    expect(() => requirePermission("viewer", "task:create")).toThrow("cannot perform");
  });

  it("prevents cross-organization resource access", () => {
    expect(() => requireSameOrganization("org_a", "org_b")).toThrow("Cross-organization");
  });

  it("reserves organization and billing administration for owners", () => {
    expect(hasPermission("owner", "billing:manage")).toBe(true);
    expect(hasPermission("admin", "billing:manage")).toBe(false);
  });

  it("grants skill approval to owners and admins but not members", () => {
    expect(hasPermission("owner", "skill:manage")).toBe(true);
    expect(hasPermission("admin", "skill:manage")).toBe(true);
    expect(hasPermission("member", "skill:manage")).toBe(false);
  });
});
