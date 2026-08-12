import { describe, expect, it } from "vitest";
import { approvalDetail, approvalKey } from "./approval";

/**
 * The approval dialog is the security boundary of the desktop app, so its rules are tested
 * directly rather than only through the component. What matters here is not that the keys work —
 * it is that the *dangerous* ones cannot happen by accident.
 */

describe("answering an approval from the keyboard", () => {
  it("maps the same letters the CLI prompt uses", () => {
    // Someone who learns y/n/a/d at the terminal must not be wrong in the window.
    expect(approvalKey({ key: "y" })).toEqual({ decision: "allow" });
    expect(approvalKey({ key: "n" })).toEqual({ decision: "deny" });
    expect(approvalKey({ key: "a" })).toEqual({ decision: "allow_always" });
    expect(approvalKey({ key: "d" })).toEqual({ decision: "deny_always" });
  });

  it("accepts them upper-case, since Shift or caps lock should not silently do nothing", () => {
    expect(approvalKey({ key: "Y" })).toEqual({ decision: "allow" });
    expect(approvalKey({ key: "D" })).toEqual({ decision: "deny_always" });
  });

  it("resolves Escape as a denial rather than just closing", () => {
    // A dialog that vanishes while the agent still waits for an answer is a hang with no visible
    // cause. Denying is the only reading that cannot approve something by accident.
    expect(approvalKey({ key: "Escape" })).toEqual({ decision: "deny" });
  });

  it("never approves on Enter or Space", () => {
    // The keys people press to dismiss a dialog must not be the keys that authorise a command.
    expect(approvalKey({ key: "Enter" })).toBeUndefined();
    expect(approvalKey({ key: " " })).toBeUndefined();
  });

  it("ignores letters carrying a modifier, which belong to the OS or the app", () => {
    expect(approvalKey({ key: "y", ctrlKey: true })).toBeUndefined();
    expect(approvalKey({ key: "a", metaKey: true })).toBeUndefined();
    expect(approvalKey({ key: "d", altKey: true })).toBeUndefined();
  });

  it("ignores everything else rather than guessing", () => {
    expect(approvalKey({ key: "k" })).toBeUndefined();
    expect(approvalKey({ key: "Tab" })).toBeUndefined();
    expect(approvalKey({ key: "ArrowDown" })).toBeUndefined();
  });
});

describe("what the dialog shows for review", () => {
  it("separates the label from the command being run", () => {
    const detail = approvalDetail("write_file", "write_file: src/app.ts");
    expect(detail.subject).toBe("src/app.ts");
    expect(detail.executes).toBe(false);
  });

  it("drops a label that only repeats the tool name the dialog already shows", () => {
    // Printed twice it is noise beside the one line that actually differs between calls.
    const detail = approvalDetail("run_command", "run_command: rm -rf build");
    expect(detail.subject).toBe("rm -rf build");
    expect(detail.note).toBeUndefined();
  });

  it("keeps a label that adds something the tool name does not", () => {
    const detail = approvalDetail("apply_patch", "edit: src/app.ts");
    expect(detail.note).toBe("edit");
    expect(detail.subject).toBe("src/app.ts");
  });

  it("marks tools that execute, which is what the warning styling keys off", () => {
    expect(approvalDetail("run_command", "ls").executes).toBe(true);
    expect(approvalDetail("bash", "ls").executes).toBe(true);
    expect(approvalDetail("write_file", "src/app.ts").executes).toBe(false);
    expect(approvalDetail("read_file", "src/app.ts").executes).toBe(false);
  });

  it("shows a bare summary whole when there is no label to split off", () => {
    expect(approvalDetail("write_file", "src/app.ts").subject).toBe("src/app.ts");
  });

  it("does not treat a colon inside the command as a label", () => {
    // The bug this pins, found by this test: splitting on any early ": " showed the user "b" as
    // the command they were approving and hid the curl entirely. A prefix containing a space is
    // part of the command, not a name for it.
    const url = approvalDetail("run_command", "curl -s https://example.com/a: b");
    expect(url.subject).toBe("curl -s https://example.com/a: b");
    expect(url.note).toBeUndefined();

    const sed = approvalDetail("run_command", "sed -i s/host: old/host: new/ conf.yml");
    expect(sed.subject).toBe("sed -i s/host: old/host: new/ conf.yml");
  });

  it("keeps a leading flag or path intact when it precedes a colon", () => {
    const git = approvalDetail("run_command", "git remote add origin git@github.com:me/repo.git");
    expect(git.subject).toBe("git remote add origin git@github.com:me/repo.git");
  });

  it("never returns an empty subject silently", () => {
    // The component renders an explicit "no detail" line instead, which is honest; an empty box
    // would read as "nothing is happening" next to four approval buttons.
    expect(approvalDetail("run_command", "   ").subject).toBeUndefined();
  });

  it("keeps the whole command, however long — truncation is not a choice this dialog gets", () => {
    const long = `run_command: ${"a".repeat(4000)}`;
    expect(approvalDetail("run_command", long).subject).toHaveLength(4000);
  });
});
