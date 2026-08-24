import { describe, expect, it } from "vitest";
import { isPublicInfrastructurePath } from "./middleware";

describe("site access gate public infrastructure", () => {
  it.each([
    "/api/defender-brain/manifest",
    "/api/defender-brain/corpus",
  ])("allows the exact machine-consumed feed route %s", (pathname) => {
    expect(isPublicInfrastructurePath(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/api/health",
    "/api/defender-brain",
    "/api/defender-brain/manifest/extra",
    "/api/defender-brain/corpus.json",
  ])("keeps %s behind the site gate", (pathname) => {
    expect(isPublicInfrastructurePath(pathname)).toBe(false);
  });
});
