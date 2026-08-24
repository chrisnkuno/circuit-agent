import { describe, expect, it } from "vitest";
import { buildWanderObjective } from "@circuit-nova/nova-core/wander";
import { assembleWanderReport, buildWanderReportHtml, markdownToHtml, WANDER_REPORT_PATH } from "./wander-report";

describe("Wander harvest report", () => {
  it("renders markdown headings and lists", () => {
    const html = markdownToHtml("# Title\n\n- one\n- two\n\n**bold** claim");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("assembles a print-ready report only when CONSENSUS.md exists", () => {
    const objective = buildWanderObjective("sleep and memory");
    expect(assembleWanderReport({ objective, files: [{ path: "wander/HYPOTHESES.md", content: "h" }] })).toBeNull();

    const report = assembleWanderReport({
      objective,
      files: [
        { path: "wander/EVIDENCE.md", content: "# Evidence\n\nSource A" },
        { path: "wander/HYPOTHESES.md", content: "# Role: PI\n\nHypothesis" },
        { path: "wander/REVIEW_METHODS.md", content: "# Methodologist\n\nCritique" },
        { path: "wander/REVIEW_RIVAL.md", content: "# Rival\n\nAlt view" },
        { path: "wander/CONSENSUS.md", content: "# Editor\n\nverified strong_plausible speculative" },
      ],
    });
    expect(report).not.toBeNull();
    expect(report!.path).toBe(WANDER_REPORT_PATH);
    expect(report!.filename).toMatch(/^wander-report-.*\.html$/);
    expect(report!.html).toContain("Wander lab report");
    expect(report!.html).toContain("Consensus");
    expect(report!.html).toContain("verified strong_plausible speculative");
  });

  it("builds a standalone HTML document", () => {
    const html = buildWanderReportHtml({
      topic: "coral bleaching",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      evidence: "e",
      hypotheses: "h",
      reviewMethods: "m",
      reviewRival: "r",
      consensus: "c",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("@media print");
    expect(html).toContain("coral bleaching");
  });
});
