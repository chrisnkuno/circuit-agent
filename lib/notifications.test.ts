import { describe, expect, it } from "vitest";
import { composeRunNotification, selectNotificationRecipients } from "./notifications";
import { sendEmail } from "./providers/resend";

describe("run lifecycle notifications", () => {
  const base = { taskTitle: "Add a README", objective: "add a README.md explaining the workspace", spentRwf: 113, maxRwf: 2400 };

  it("reports what was spent against what was approved, even when the run failed", () => {
    const message = composeRunNotification({ ...base, event: "failed", detail: "A verification command failed." });
    expect(message.subject).toBe("Failed: Add a README");
    // Silence about cost on a failure reads as "this cost nothing", which is usually untrue.
    expect(message.text).toContain("of");
    expect(message.text).toMatch(/Spent:.*approved/);
    expect(message.text).toContain("A verification command failed.");
  });

  it("shows the approved cap rather than a spend that has not happened yet on start", () => {
    const message = composeRunNotification({ ...base, event: "started", spentRwf: 0 });
    expect(message.subject).toBe("Started: Add a README");
    expect(message.text).toContain("Approved cap:");
    expect(message.text).not.toContain("Spent:");
  });

  it("says stopped, not failed, for a cancelled run", () => {
    const message = composeRunNotification({ ...base, event: "cancelled" });
    expect(message.subject).toBe("Stopped: Add a README");
    expect(message.text).toContain("was stopped");
  });

  it("keeps the subject and body bounded for a long objective", () => {
    const message = composeRunNotification({ ...base, event: "completed", taskTitle: "T".repeat(400), objective: "o".repeat(4_000) });
    expect(message.subject.length).toBeLessThanOrEqual(200);
    expect(message.text).toContain("…");
  });

  it("links to the live run when a workspace url is configured", () => {
    const message = composeRunNotification({ ...base, event: "completed", workspaceUrl: "https://example.test/terminal" });
    expect(message.text).toContain("https://example.test/terminal");
  });
});

describe("notification recipients", () => {
  it("emails only members whose address was actually recorded", () => {
    const recipients = selectNotificationRecipients([
      { notificationEmail: "owner@example.test", status: "active" },
      { notificationEmail: undefined, status: "active" },
      { notificationEmail: "  ", status: "active" },
    ]);
    expect(recipients).toEqual(["owner@example.test"]);
  });

  it("never emails a suspended member, and never twice", () => {
    const recipients = selectNotificationRecipients([
      { notificationEmail: "owner@example.test", status: "active" },
      { notificationEmail: "OWNER@example.test", status: "active" },
      { notificationEmail: "removed@example.test", status: "suspended" },
    ]);
    expect(recipients).toEqual(["owner@example.test"]);
  });
});

describe("resend adapter", () => {
  const valid = { apiKey: "re_test", from: "Circuit <bot@example.test>", to: ["owner@example.test"], subject: "Completed", text: "done" };

  function respond(status: number, body: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  }

  it("sends the message and returns the provider id", async () => {
    let captured: RequestInit | undefined;
    const request = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(sendEmail({ ...valid, from: "bot@example.test" }, request)).resolves.toEqual({ id: "msg_1" });
    expect(captured?.headers).toMatchObject({ authorization: "Bearer re_test" });
    expect(JSON.parse(String(captured?.body))).toMatchObject({ to: ["owner@example.test"], subject: "Completed" });
  });

  it("rejects an address that cannot be an email before calling the provider", async () => {
    let called = false;
    const request = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await expect(sendEmail({ ...valid, from: "bot@example.test", to: ["not-an-address"] }, request)).rejects.toThrow(/valid email address/);
    expect(called).toBe(false);
  });

  it("fails loudly on a provider error so a caller cannot mistake it for delivery", async () => {
    await expect(sendEmail({ ...valid, from: "bot@example.test" }, respond(422, { message: "domain is not verified" })))
      .rejects.toThrow(/422.*domain is not verified/);
  });

  it("never puts the api key in an error a caller may store or display", async () => {
    await expect(sendEmail({ ...valid, from: "bot@example.test", apiKey: "re_supersecret" }, respond(401, { message: "invalid" })))
      .rejects.toThrow(/^(?!.*re_supersecret).*$/);
  });

  it("treats an accepted request with no message id as a failure", async () => {
    await expect(sendEmail({ ...valid, from: "bot@example.test" }, respond(200, {}))).rejects.toThrow(/without returning a message id/);
  });
});
