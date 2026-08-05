import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recover expired agent leases", { minutes: 1 }, internal.agentRuns.recoverExpiredLeases, { maxAttempts: 3 });
crons.interval("claim due Google Calendar schedules", { minutes: 5 }, internal.googleCalendar.runDueSchedules, {});

export default crons;
