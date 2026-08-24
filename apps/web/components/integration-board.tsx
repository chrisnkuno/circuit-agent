"use client";

import { useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { IntegrationNetwork } from "@/components/integration-network";
import { connectorRegistry } from "@/lib/connectors";
import { buildMultiAppWorkflow, type WorkflowTemplate } from "@/lib/multitasker";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const templates: { id: WorkflowTemplate; label: string }[] = [
  { id: "meeting-follow-up", label: "Meeting follow-up" },
  { id: "inbox-to-plan", label: "Inbox to daily plan" },
  { id: "project-update", label: "Project status update" },
  { id: "evening-routine", label: "Evening routine" },
];

export function IntegrationBoard({ organizationId }: { organizationId?: Id<"organizations"> }) {
  const [template, setTemplate] = useState<WorkflowTemplate>("meeting-follow-up");
  const [notice, setNotice] = useState<string | null>(null);
  const [focusConnector, setFocusConnector] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ id: string; summary: string; start: string }>>([]);
  const [eventTitle, setEventTitle] = useState("Focus review");
  const [eventStart, setEventStart] = useState(isoLocal(Date.now() + 60 * 60_000));
  const [eventEnd, setEventEnd] = useState(isoLocal(Date.now() + 2 * 60 * 60_000));
  const connections = useQuery(api.connectors.listForOrganization, organizationId ? { organizationId } : "skip");
  const tasks = useQuery(api.tasks.listRecent, organizationId ? { organizationId } : "skip");
  const actionIntents = useQuery(api.connectors.listActionIntents, organizationId ? { organizationId } : "skip");
  const schedules = useQuery(api.connectors.listSchedules, organizationId ? { organizationId } : "skip");
  const pendingApprovals = useQuery(api.approvals.listPending, organizationId ? { organizationId } : "skip");
  const beginOAuth = useAction(api.googleCalendar.beginOAuth);
  const listUpcoming = useAction(api.googleCalendar.listUpcoming);
  const proposeEvent = useAction(api.googleCalendar.proposeEvent);
  const executeEvent = useAction(api.googleCalendar.executeApprovedEvent);
  const revokeGoogle = useAction(api.googleCalendar.revoke);
  const decideApproval = useMutation(api.approvals.decide);
  const createSchedule = useMutation(api.connectors.createSchedule);
  const setScheduleStatus = useMutation(api.connectors.setScheduleStatus);
  const workflow = useMemo(() => buildMultiAppWorkflow(template, `preview-${template}`), [template]);
  const focusedConnector = focusConnector ? connectorRegistry.get(focusConnector) : undefined;
  const focusedIntents = useMemo(() => focusConnector ? workflow.intents.filter((intent) => intent.connectorId === focusConnector) : [], [focusConnector, workflow]);
  const focusedConnected = focusConnector ? Boolean(connections?.find((item) => item.connectorId === focusConnector && item.status === "connected")) : false;
  const templatesUsingConnector = useMemo(() => {
    if (!focusConnector) return [];
    return templates
      .filter((item) => buildMultiAppWorkflow(item.id, `probe-${item.id}`).intents.some((intent) => intent.connectorId === focusConnector))
      .map((item) => item.label);
  }, [focusConnector]);
  const calendarConnection = connections?.find((item) => item.connectorId === "google-calendar" && item.status === "connected");
  const latestOperationsTask = tasks?.find((item) => item.kind === "operations" && !["completed", "cancelled"].includes(item.status));
  const calendarIntents = actionIntents?.filter((item) => item.connectorId === "google-calendar") ?? [];

  async function connectGoogle() {
    if (!organizationId) return setNotice("Sign in before connecting Google Calendar.");
    try { const result = await beginOAuth({ organizationId }); window.location.assign(result.authorizationUrl); }
    catch (error) { setNotice(errorMessage(error)); }
  }

  async function readCalendar() {
    if (!organizationId) return;
    try {
      const timeMin = new Date().toISOString();
      const result = await listUpcoming({ organizationId, timeMin, timeMax: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(), maxResults: 25 });
      setEvents(result); setNotice(`Read ${result.length} event${result.length === 1 ? "" : "s"} from the connected primary calendar.`);
    } catch (error) { setNotice(errorMessage(error)); }
  }

  async function proposeCalendarEvent() {
    if (!organizationId || !latestOperationsTask) return setNotice("Create an operations task first so the proposal has a durable task and budget owner.");
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      await proposeEvent({ organizationId, taskId: latestOperationsTask._id, idempotencyKey: crypto.randomUUID(), event: { summary: eventTitle, start: new Date(eventStart).toISOString(), end: new Date(eventEnd).toISOString(), timeZone: timezone } });
      setNotice("Calendar event proposed. It cannot execute until its external-action approval is accepted.");
    } catch (error) { setNotice(errorMessage(error)); }
  }

  async function enableDigest() {
    if (!organizationId) return;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const scheduleId = await createSchedule({ organizationId, title: "Morning calendar digest", workflowTemplate: "calendar-digest", cronExpression: "0 7 * * *", timezone, connectorIds: ["google-calendar"] });
      await setScheduleStatus({ scheduleId, status: "active" });
      setNotice(`Calendar digest activated for 07:00 ${timezone}.`);
    } catch (error) { setNotice(errorMessage(error)); }
  }

  return <section className="integration-section" id="integrations">
    <IntegrationNetwork />
    <div className="integration-intro" data-rv="up">
      <div><p className="eyebrow">03 / DAILY-LIFE MULTITASKER</p><h2>Many apps. One controlled workflow.</h2><p>Combine calendars, messages, files, tasks, notes, and home state. Read-only work can run in parallel; anything consequential becomes a durable approval before execution.</p></div>
      <div className="permission-key" aria-label="Connector permission levels"><span>READ</span><span>DRAFT</span><span>EXECUTE + APPROVAL</span></div>
    </div>
    <div className="connector-grid" data-rv="up">
      {connectorRegistry.list().map((connector) => {
        const connected = connector.id === "google-calendar" && Boolean(calendarConnection);
        const selected = focusConnector === connector.id;
        return <article className={`connector-card${selected ? " selected" : ""}`} key={connector.id} data-connector-id={connector.id} role="button" tabIndex={0} aria-pressed={selected} onClick={() => setFocusConnector((current) => (current === connector.id ? null : connector.id))} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setFocusConnector((current) => (current === connector.id ? null : connector.id)); } }}>
          <div className="connector-inner">
            <header><span className="app-mark">{connector.appName.slice(0, 2).toUpperCase()}</span><b className={connected ? "connector-state connected" : "connector-state"}>{connected ? "Connected" : "Not connected"}</b></header>
            <h3>{connector.appName}</h3><p>{connector.description}</p>
            <footer><span>{connector.domains.join(" · ")}</span><small>{connected ? calendarConnection?.externalAccountLabel ?? "Provider account" : `${connector.auth.toUpperCase()} setup required`}</small></footer>
            {connector.id === "google-calendar" && <button className="connector-button" onClick={connected ? readCalendar : connectGoogle}>{connected ? "Read next 7 days" : "Connect Google"}</button>}
          </div>
        </article>;
      })}
    </div>
    {focusedConnector && <div className="flow-inspector" key={`${focusedConnector.id}-${template}`}>
      <div className="fi-head">
        <span className="fi-k">FLOW INSPECTOR — {focusedConnector.appName}</span>
        <span className={`fi-auth${focusedConnected ? " on" : ""}`}>{focusedConnected ? "Connected" : `${focusedConnector.auth.toUpperCase()} setup required`}</span>
      </div>
      <p className="fi-desc">{focusedConnector.description}</p>
      <div className="fi-meta"><span className="fi-domains">{focusedConnector.domains.join(" · ")}</span><span className="fi-scope">READ · DRAFT · EXECUTE + APPROVAL</span></div>
      <ul className="fi-actions">{focusedConnector.actions.map((action) => <li key={action.id}><b>{action.permission.toUpperCase()}</b><span>{action.label}</span>{action.requiresApproval && <em>approval</em>}</li>)}</ul>
      {focusedIntents.length > 0
        ? <p className="fi-trace">{focusedConnector.appName} appears in <b>{workflow.title}</b> as {focusedIntents.length} step{focusedIntents.length === 1 ? "" : "s"}: {focusedIntents.map((intent) => intent.title).join(" · ")}.</p>
        : <p className="fi-trace">{focusedConnector.appName} is not used by <b>{workflow.title}</b>.{templatesUsingConnector.length > 0 ? ` It appears in ${templatesUsingConnector.length === 1 ? "the" : "these templates:"} ${templatesUsingConnector.join(", ")} — pick ${templatesUsingConnector.length === 1 ? "that" : "one"} to trace its path.` : " No template uses it yet."}</p>}
    </div>}
    {calendarConnection && <div className="calendar-console">
      <div><span>LIVE GOOGLE CALENDAR</span><h3>Scoped read and approved write</h3><p>Tokens are encrypted at rest. Event contents are stored as encrypted action payloads; creation waits for a linked approval.</p></div>
      <div className="calendar-form"><label>Event title<input value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} /></label><label>Start<input type="datetime-local" value={eventStart} onChange={(event) => setEventStart(event.target.value)} /></label><label>End<input type="datetime-local" value={eventEnd} onChange={(event) => setEventEnd(event.target.value)} /></label><button className="outline" onClick={proposeCalendarEvent}>Propose event</button><button className="outline" onClick={enableDigest} disabled={schedules?.some((item) => item.workflowTemplate === "calendar-digest" && item.status === "active")}>Enable 07:00 digest</button><button className="danger-link" onClick={async () => { if (organizationId) { await revokeGoogle({ organizationId }); setNotice("Google Calendar access revoked."); } }}>Revoke Google</button></div>
      {events.length > 0 && <ul className="calendar-events">{events.map((event) => <li key={event.id}><strong>{event.summary}</strong><span>{event.start}</span></li>)}</ul>}
      {calendarIntents.map((intent) => {
        const approval = pendingApprovals?.find((item) => item.actionIntentId === intent._id);
        return <div className="intent-row" key={intent._id}><span>{intent.inputSummary}</span><b>{intent.status.replaceAll("_", " ")}</b>{approval && <button onClick={() => decideApproval({ approvalId: approval._id, decision: "approved" })}>Approve</button>}{intent.status === "approved" && <button onClick={async () => { await executeEvent({ actionIntentId: intent._id }); setNotice("Approved event executed through Google Calendar."); }}>Execute approved event</button>}</div>;
      })}
    </div>}
    <div className="workflow-preview" data-rv="up">
      <div className="workflow-picker"><div><span>WORKFLOW COMPILER</span><h3>{workflow.title}</h3><p>{workflow.description} This is a local plan preview; it does not execute app actions.</p></div><label>Daily workflow<select value={template} onChange={(event) => setTemplate(event.target.value as WorkflowTemplate)}>{templates.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label></div>
      <ol>{workflow.intents.map((intent, index) => <li key={intent.key}><span className="workflow-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{intent.title}</strong><small>{connectorRegistry.get(intent.connectorId)?.appName} · after {intent.dependsOn.length ? intent.dependsOn.join(" + ") : "workflow start"}</small></div><b className={intent.requiresApproval ? "approval-chip" : "read-chip"}>{intent.requiresApproval ? "Approval required" : "Read only"}</b></li>)}</ol>
    </div>
    <p className="integration-notice" data-rv="up">{notice ?? (calendarConnection ? "Google Calendar is backed by a real encrypted OAuth connection. Every other app remains unconfigured." : "Google Calendar is implemented but requires configured Google OAuth credentials and user consent. No card above represents a simulated connection.")}</p>
  </section>;
}

function isoLocal(timestamp: number): string {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Connector operation failed"; }
