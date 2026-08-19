import { describe, expect, it } from "vitest";
import {
  applyDefenderAction,
  composeDefenderFrame,
  detailLines,
  fixObjective,
  keyToDefenderAction,
  newDefenderState,
  posture,
  runDefenderTriage,
  selectedFinding,
  visibleFindings,
  type DefenderState,
} from "./defender-screen";
import { visibleWidth } from "./markdown";

const findings = [
  { path: "src/config.ts", line: 42, kind: "AWS access key", masked: "AKIA…7Q2P", severity: "critical" as const },
  { path: "deploy/ci.yml", line: 18, kind: "GitHub token", masked: "ghp_…9fA1", severity: "critical" as const },
  { path: "src/maps.ts", line: 7, kind: "Google API key", masked: "AIza…kk31", severity: "high" as const },
  { path: "tests/fixtures.ts", line: 3, kind: "credential-looking assignment", masked: "pass…word", severity: "medium" as const },
];
const style = { depth: "none" as const };
const start = (): DefenderState => newDefenderState(findings, 80, 30);
const key = (name: string, character?: string) => keyToDefenderAction({ name } as never, character);

describe("the triage queue", () => {
  it("starts with everything open and nothing decided", () => {
    const state = start();
    expect(posture(state)).toMatchObject({ total: 4, triaged: 0, worst: "critical" });
    expect(visibleFindings(state)).toHaveLength(4);
  });

  it("counts a decision as progress, whichever decision it was", () => {
    let state = start();
    state = applyDefenderAction(state, { kind: "mark", triage: "ignored" });
    state = applyDefenderAction(state, { kind: "move", step: 1 });
    state = applyDefenderAction(state, { kind: "fix" });
    expect(posture(state).triaged).toBe(2);
    // Two criticals were the worst; one is ignored and one is being fixed, so the worst *open*
    // finding is now the high — which is the number a person is actually asking about.
    expect(posture(state).worst).toBe("high");
  });

  it("moves within the list and never off either end", () => {
    let state = start();
    for (let step = 0; step < 10; step += 1) state = applyDefenderAction(state, { kind: "move", step: 1 });
    expect(state.selected).toBe(3);
    for (let step = 0; step < 10; step += 1) state = applyDefenderAction(state, { kind: "move", step: -1 });
    expect(state.selected).toBe(0);
  });

  it("keeps the cursor on the same finding when the filter changes under it", () => {
    let state = applyDefenderAction(start(), { kind: "move", step: 2 });
    const before = selectedFinding(state);
    state = applyDefenderAction(state, { kind: "filter", value: "high" });
    expect(selectedFinding(state)).toBe(before);
    expect(visibleFindings(state)).toHaveLength(1);
  });

  it("shows only what the filter admits, and everything again when it is cleared", () => {
    let state = applyDefenderAction(start(), { kind: "filter", value: "critical" });
    expect(visibleFindings(state).every((finding) => finding.severity === "critical")).toBe(true);
    state = applyDefenderAction(state, { kind: "mark", triage: "ignored" });
    state = applyDefenderAction(state, { kind: "filter", value: "open" });
    expect(visibleFindings(state)).toHaveLength(3);
    state = applyDefenderAction(state, { kind: "filter", value: "all" });
    expect(visibleFindings(state)).toHaveLength(4);
  });

  it("never leaves the cursor past the end after a decision hides the row it was on", () => {
    let state = applyDefenderAction(start(), { kind: "filter", value: "open" });
    for (let step = 0; step < 4; step += 1) {
      state = applyDefenderAction(state, { kind: "move", step: 1 });
      state = applyDefenderAction(state, { kind: "mark", triage: "ignored" });
      expect(state.selected).toBeLessThanOrEqual(Math.max(0, visibleFindings(state).length - 1));
    }
    expect(posture(state).triaged).toBeGreaterThan(0);
  });

  it("resets the detail scroll when the finding changes, but not when it does not", () => {
    let state = applyDefenderAction(start(), { kind: "scroll", rows: 2 });
    const scrolled = state.detailScroll;
    expect(applyDefenderAction(state, { kind: "move", step: 1 }).detailScroll).toBe(0);
    state = applyDefenderAction(state, { kind: "move", step: -1 }); // already at the top: no change
    expect(state.detailScroll).toBe(scrolled);
  });

  it("does nothing at all when there is nothing to act on", () => {
    const empty = newDefenderState([], 80, 30);
    for (const action of [{ kind: "move", step: 1 }, { kind: "mark", triage: "ignored" }, { kind: "fix" }, { kind: "scroll", rows: 3 }] as const) {
      expect(applyDefenderAction(empty, action)).toEqual(empty);
    }
    expect(posture(empty)).toMatchObject({ total: 0, triaged: 0, worst: undefined });
  });
});

describe("keys", () => {
  it("keeps the two decisions off the movement keys and off Enter", () => {
    expect(key("f", "f")).toEqual({ kind: "fix" });
    expect(key("i", "i")).toEqual({ kind: "mark", triage: "ignored" });
    expect(key("return")).toEqual({ kind: "none" });
    expect(key("down")).toEqual({ kind: "move", step: 1 });
    expect(key("j", "j")).toEqual({ kind: "move", step: 1 });
    expect(key("escape")).toEqual({ kind: "exit" });
    expect(key("1", "1")).toEqual({ kind: "filter", value: "critical" });
  });
});

describe("the detail pane", () => {
  it("says where it is, what it is, and what to do about it — without printing the secret", () => {
    const finding = { ...findings[0], triage: "open" as const };
    const lines = detailLines(finding, 78).join("\n");
    expect(lines).toContain("src/config.ts:42");
    expect(lines).toContain("AWS access key");
    expect(lines).toContain("AKIA…7Q2P");
    expect(lines).toContain("Rotate");
    expect(lines).toContain("lead, not proof");
  });

  it("carries the evidence when there is some", () => {
    const finding = { ...findings[0], triage: "open" as const, evidence: ["41 | const client = new S3({", "42 | accessKeyId: AKIA…7Q2P"] };
    expect(detailLines(finding, 78).join("\n")).toContain("evidence");
    expect(detailLines(finding, 78).join("\n")).toContain("const client");
  });

  it("wraps to the width it is given rather than running off the pane", () => {
    for (const width of [40, 60, 100]) {
      for (const line of detailLines({ ...findings[0], triage: "open" }, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(20, width - 6));
      }
    }
  });
});

describe("what a fix asks for", () => {
  it("names the finding, demands verification first, and forbids printing the secret", () => {
    const objective = fixObjective({ ...findings[0], triage: "fixing" });
    expect(objective).toContain("src/config.ts:42");
    expect(objective).toContain("AWS access key");
    expect(objective).toMatch(/placeholder/);
    expect(objective).toMatch(/rotat/i);
    expect(objective).toContain("Do not print the secret");
  });
});

describe("the frame", () => {
  it("fits the terminal it was given, at every width", () => {
    for (const columns of [120, 80, 60, 40]) {
      const frame = composeDefenderFrame({ ...start(), columns }, { ...style, width: columns });
      for (const row of frame.join("\n").split("\n")) expect(visibleWidth(row), row).toBeLessThanOrEqual(columns);
    }
  });

  it("keeps the same number of rows however the queue is filtered, so the frame does not jump", () => {
    const all = composeDefenderFrame(start(), { ...style, width: 80 }).join("\n").split("\n").length;
    const filtered = composeDefenderFrame(applyDefenderAction(start(), { kind: "filter", value: "medium" }), { ...style, width: 80 }).join("\n").split("\n").length;
    expect(filtered).toBe(all);
  });

  it("says what is worst and how far along the pass is", () => {
    const rendered = composeDefenderFrame(start(), { ...style, width: 80 }).join("\n");
    expect(rendered).toContain("worst open: critical");
    expect(rendered).toContain("triaged 0/4");
    expect(rendered).toContain("critical");
  });

  it("draws an empty queue as an empty queue rather than throwing", () => {
    expect(() => composeDefenderFrame(newDefenderState([], 80, 30), { ...style, width: 80 })).not.toThrow();
    expect(composeDefenderFrame(newDefenderState([], 80, 30), { ...style, width: 80 }).join("\n")).toContain("nothing to triage");
  });
});

describe("the loop", () => {
  async function* press(...keys: Array<{ name?: string; str?: string }>) {
    for (const entry of keys) yield { str: entry.str, key: { name: entry.name } as never };
  }

  it("returns the decisions instead of acting on them", async () => {
    const frames: string[] = [];
    const outcome = await runDefenderTriage(
      press({ str: "f", name: "f" }, { name: "down" }, { str: "i", name: "i" }, { name: "escape" }),
      findings,
      (frame) => frames.push(frame),
      { width: 80, rows: 30, style },
    );

    expect(outcome.toFix.map((finding) => finding.path)).toEqual(["src/config.ts"]);
    expect(outcome.findings.filter((finding) => finding.triage === "ignored")).toHaveLength(1);
    expect(frames.length).toBeGreaterThan(1);
  });

  it("asks for evidence once per finding, and only for the one being looked at", async () => {
    const asked: string[] = [];
    await runDefenderTriage(
      press({ name: "down" }, { name: "up" }, { name: "down" }, { name: "escape" }),
      findings,
      () => {},
      {
        width: 80, rows: 30, style,
        loadEvidence: async (finding) => { asked.push(finding.path); return ["a line"]; },
      },
    );
    expect(asked).toEqual(["src/config.ts", "deploy/ci.yml"]);
  });

  it("survives a loader that fails rather than taking the screen down with it", async () => {
    const outcome = await runDefenderTriage(
      press({ name: "down" }, { name: "escape" }),
      findings,
      () => {},
      { width: 80, rows: 30, style, loadEvidence: async () => { throw new Error("unreadable"); } },
    );
    expect(outcome.findings).toHaveLength(4);
  });

  it("never queues the same finding twice", async () => {
    const outcome = await runDefenderTriage(
      press({ str: "f", name: "f" }, { str: "f", name: "f" }, { name: "escape" }),
      findings,
      () => {},
      { width: 80, rows: 30, style },
    );
    expect(outcome.toFix).toHaveLength(1);
  });
});
