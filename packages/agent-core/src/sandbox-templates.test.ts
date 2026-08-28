import { describe, expect, it } from "vitest";
import { ALLOWED_SANDBOX_PROGRAMS } from "./sandbox-policy";
import { DEFAULT_WORKSPACE_PRESET_ID, WORKSPACE_PRESETS, findWorkspacePreset, inferWorkspacePresetId, presetPrograms } from "./sandbox-templates";

/**
 * Workspace presets, and the boundary they must never widen.
 *
 * A preset is a convenience — a prebuilt image so a session does not spend its first minute
 * installing pytest. The security property is that it stays a convenience: declaring a program in a
 * preset must not make that program runnable if the policy does not permit it, or the allowlist
 * becomes advisory and the image becomes the real policy.
 */

describe("workspace presets", () => {
  it("cannot widen the sandbox policy by declaring extra programs", () => {
    const smuggled = { ...WORKSPACE_PRESETS[0], programs: [...WORKSPACE_PRESETS[0].programs, "bash", "curl"] as never };
    const allowed = presetPrograms(smuggled);
    expect(allowed).not.toContain("bash");
    expect(allowed).not.toContain("curl");
    for (const program of allowed) expect(ALLOWED_SANDBOX_PROGRAMS).toContain(program);
  });

  it("offers only permitted programs from every shipped preset", () => {
    for (const preset of WORKSPACE_PRESETS) {
      for (const program of presetPrograms(preset)) {
        expect(ALLOWED_SANDBOX_PROGRAMS, `${preset.id}/${program}`).toContain(program);
      }
      expect(presetPrograms(preset).length, preset.id).toBeGreaterThan(0);
    }
  });

  it("describes every preset well enough to choose between them", () => {
    const ids = WORKSPACE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_WORKSPACE_PRESET_ID);
    for (const preset of WORKSPACE_PRESETS) {
      expect(preset.label.trim().length, preset.id).toBeGreaterThan(0);
      expect(preset.description.trim().length, preset.id).toBeGreaterThan(20);
      expect(preset.templateAlias.trim().length, preset.id).toBeGreaterThan(0);
    }
  });

  it("falls back to a working preset rather than returning nothing for an unknown id", () => {
    // An unrecognised id comes from stale settings or a hand-edited file; a session that cannot
    // start because of one is a worse answer than the default image.
    for (const id of [undefined, "", "no-such-preset"]) {
      expect(findWorkspacePreset(id).id, String(id)).toBe(WORKSPACE_PRESETS[0].id);
    }
    expect(findWorkspacePreset("python-data").id).toBe("python-data");
  });

  it("routes app-building objectives to the deployable Next.js image", () => {
    expect(inferWorkspacePresetId("Build me a responsive logistics dashboard")).toBe("next-app");
    expect(inferWorkspacePresetId("Create a web app for field teams")).toBe("next-app");
    expect(inferWorkspacePresetId("Fix the parser regression")).toBeUndefined();
  });
});
