"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { CalendarClock, Compass, Link2, Link2Off, MessagesSquare } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useCurrentOrganization } from "@/components/auth-panel";
import { SidePanel } from "@/components/side-panel";
import {
  buildWanderScheduleObjective,
  isWanderObjective,
  WANDER_CADENCE_CRON,
  type WanderCadence,
} from "../packages/agent-core/src/wander";

const INTERVAL_PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 9am", cron: "0 9 * * *" },
  { label: "Daily at 6pm", cron: "0 18 * * *" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}

export function SchedulePanel() {
  const organization = useCurrentOrganization();
  const links = useQuery(api.channels.listForOrganization, organization ? { organizationId: organization._id } : "skip");
  const schedules = useQuery(api.connectors.listSchedules, organization ? { organizationId: organization._id } : "skip");
  const startLinkAttempt = useMutation(api.channels.startLinkAttempt);
  const revokeLink = useMutation(api.channels.revokeLink);
  const createSchedule = useMutation(api.connectors.createSchedule);
  const setScheduleStatus = useMutation(api.connectors.setScheduleStatus);

  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [cron, setCron] = useState(INTERVAL_PRESETS[2].cron);
  const [notice, setNotice] = useState<string | null>(null);
  const [wanderBusy, setWanderBusy] = useState<Exclude<WanderCadence, "once"> | null>(null);

  const linkedTelegram = links?.find((link) => link.channel === "telegram" && link.status === "linked");
  const codingSchedules = (schedules ?? []).filter((schedule) => schedule.workflowTemplate === "coding-task" && !isWanderObjective(schedule.objective ?? ""));
  const wanderSchedules = (schedules ?? []).filter((schedule) => schedule.workflowTemplate === "coding-task" && isWanderObjective(schedule.objective ?? ""));

  async function handleLinkTelegram() {
    if (!organization) return;
    try {
      const result = await startLinkAttempt({ organizationId: organization._id, channel: "telegram" });
      setLinkCode(result.code);
      setNotice(null);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function handleCreateSchedule(event: FormEvent) {
    event.preventDefault();
    if (!organization || !objective.trim()) return;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const scheduleId = await createSchedule({
        organizationId: organization._id,
        title: objective.trim().slice(0, 60),
        workflowTemplate: "coding-task",
        cronExpression: cron,
        timezone,
        connectorIds: [],
        objective: objective.trim(),
      });
      await setScheduleStatus({ scheduleId, status: "active" });
      setObjective("");
      setNotice("Schedule created and active — it runs on the same real dispatcher as everything else here.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function enableWander(cadence: Exclude<WanderCadence, "once">) {
    if (!organization) return;
    setWanderBusy(cadence);
    setNotice(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const scheduleId = await createSchedule({
        organizationId: organization._id,
        title: `Wander ${cadence}`,
        workflowTemplate: "coding-task",
        cronExpression: WANDER_CADENCE_CRON[cadence],
        timezone,
        connectorIds: [],
        objective: buildWanderScheduleObjective(cadence),
      });
      await setScheduleStatus({ scheduleId, status: "active" });
      setNotice(`Wander ${cadence} is on — each tick picks a topic, pulls a thrifty Exa briefing, and writes the contested notebook in a real sandbox.`);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setWanderBusy(null);
    }
  }

  if (!organization) return null;

  return (
    <div className="schedule-panel">
      <SidePanel
        title="Channels"
        icon={MessagesSquare}
        actions={linkedTelegram ? <span className="schedule-linked">Linked</span> : undefined}
      >
        {linkedTelegram ? (
          <div className="schedule-row">
            <button className="outline" onClick={() => revokeLink({ linkId: linkedTelegram._id })}>
              <Link2Off size={13} strokeWidth={1.75} aria-hidden="true" />
              Unlink Telegram
            </button>
          </div>
        ) : linkCode ? (
          <div className="schedule-row schedule-code-row">
            <code>/link {linkCode}</code>
            <span className="schedule-hint">→ send to the bot, expires in 15m</span>
          </div>
        ) : (
          <button className="outline" onClick={handleLinkTelegram}>
            <Link2 size={13} strokeWidth={1.75} aria-hidden="true" />
            Link Telegram
          </button>
        )}
      </SidePanel>

      <SidePanel title="Wander" icon={Compass} count={wanderSchedules.length || undefined}>
        <p className="schedule-hint">
          Each run opens a short research notebook in a live sandbox — Exa finds the sources once, then the lab argues through hypotheses, methods critique, a rival view, and a graded consensus.
        </p>
        <div className="wander-cadence-row">
          <button type="button" className="outline" disabled={wanderBusy !== null} onClick={() => void enableWander("daily")}>
            {wanderBusy === "daily" ? "Scheduling…" : "Wander daily"}
          </button>
          <button type="button" className="outline" disabled={wanderBusy !== null} onClick={() => void enableWander("weekly")}>
            {wanderBusy === "weekly" ? "Scheduling…" : "Wander weekly"}
          </button>
        </div>
        {wanderSchedules.length > 0 && (
          <ul className="schedule-list">
            {wanderSchedules.map((schedule) => (
              <li key={schedule._id}>
                <span className="schedule-objective" title={schedule.objective ?? schedule.title}>{schedule.title}</span>
                <b className={`schedule-status schedule-status-${schedule.status}`}>{schedule.status}</b>
                <button
                  className="outline"
                  onClick={() => setScheduleStatus({ scheduleId: schedule._id, status: schedule.status === "active" ? "paused" : "active" })}
                >
                  {schedule.status === "active" ? "Pause" : "Activate"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SidePanel>

      <SidePanel title="Recurring" icon={CalendarClock} count={codingSchedules.length || undefined}>
        <form className="schedule-form" onSubmit={handleCreateSchedule}>
          <input placeholder="Objective, e.g. run the lint check" value={objective} onChange={(event) => setObjective(event.target.value)} />
          <select value={cron} onChange={(event) => setCron(event.target.value)} aria-label="Schedule interval">
            {INTERVAL_PRESETS.map((preset) => <option key={preset.cron} value={preset.cron}>{preset.label}</option>)}
          </select>
          <button className="primary" type="submit" disabled={!objective.trim()}>Schedule</button>
        </form>
        {codingSchedules.length > 0 && (
          <ul className="schedule-list">
            {codingSchedules.map((schedule) => (
              <li key={schedule._id}>
                <span className="schedule-objective">{schedule.objective}</span>
                <b className={`schedule-status schedule-status-${schedule.status}`}>{schedule.status}</b>
                <button
                  className="outline"
                  onClick={() => setScheduleStatus({ scheduleId: schedule._id, status: schedule.status === "active" ? "paused" : "active" })}
                >
                  {schedule.status === "active" ? "Pause" : "Activate"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SidePanel>

      {notice && <p className="schedule-notice">{notice}</p>}
    </div>
  );
}
