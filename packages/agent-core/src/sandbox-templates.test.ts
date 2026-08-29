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

  // Live campaign evidence: "expense tracker page" and "landing site" both fell through to the
  // plain image, which produced a bare index.html with nothing serving port 3000, so the live
  // preview answered 502. People ask for a "page", not an "app".
  it("routes the way people actually word a web request, not just the word 'app'", () => {
    expect(inferWorkspacePresetId("Build an expense tracker page showing expenses by category")).toBe("next-app");
    expect(inferWorkspacePresetId("Build a to-do list page where items can be added")).toBe("next-app");
    expect(inferWorkspacePresetId("Build a one-page coffee shop landing site with hours")).toBe("next-app");
    expect(inferWorkspacePresetId("Create a storefront for a bakery")).toBe("next-app");
  });

  // The surface words must not drag command-line and API work onto the app image.
  it("lets a stated non-web artifact veto the surface vocabulary", () => {
    expect(inferWorkspacePresetId("Create a Python command-line tool that converts Markdown to an HTML page")).toBeUndefined();
    expect(inferWorkspacePresetId("Build a Node.js webhook inspection API with POST /events")).toBeUndefined();
    expect(inferWorkspacePresetId("Create a Node.js password strength checking module")).toBeUndefined();
    expect(inferWorkspacePresetId("Build a URL shortener API with in-memory storage")).toBeUndefined();
  });

  // An explicit app word still wins, so a full product ask is never downgraded by one stray noun.
  it("keeps an explicit app word authoritative over the veto", () => {
    expect(inferWorkspacePresetId("Build a dashboard app with an API behind it")).toBe("next-app");
  });
});
