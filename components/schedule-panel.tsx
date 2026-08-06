"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useCurrentOrganization } from "@/components/auth-panel";

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

  const linkedTelegram = links?.find((link) => link.channel === "telegram" && link.status === "linked");
  const codingSchedules = (schedules ?? []).filter((schedule) => schedule.workflowTemplate === "coding-task");

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

  if (!organization) return null;

  return (
    <div className="schedule-panel">
      <div className="schedule-section">
        <h3>Telegram</h3>
        <p className="schedule-hint">Run and check tasks from Telegram instead of this page.</p>
        {linkedTelegram ? (
          <div className="schedule-row">
            <span className="schedule-linked">Linked</span>
            <button className="outline" onClick={() => revokeLink({ linkId: linkedTelegram._id })}>Unlink</button>
          </div>
        ) : linkCode ? (
          <div className="schedule-row schedule-code-row">
            <span>
              Send <code>/link {linkCode}</code> to the bot — code expires in 15 minutes.
            </span>
          </div>
        ) : (
          <button className="outline" onClick={handleLinkTelegram}>Link Telegram</button>
        )}
      </div>

      <div className="schedule-section">
        <h3>Recurring coding tasks</h3>
        <p className="schedule-hint">Runs a real coding task on the schedule below, through the same dispatcher.</p>
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
      </div>

      {notice && <p className="schedule-notice">{notice}</p>}
    </div>
  );
}
