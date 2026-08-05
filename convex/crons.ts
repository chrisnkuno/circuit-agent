import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recover expired agent leases", { minutes: 1 }, internal.agentRuns.recoverExpiredLeases, { maxAttempts: 3 });
crons.interval("claim due Google Calendar schedules", { minutes: 5 }, internal.googleCalendar.runDueSchedules, {});
// Overlapping ticks are safe: claimStep only transitions a step out of pending/ready once,
// so a second tick that races an in-flight one simply finds nothing left to claim.
crons.interval("dispatch queued coding work", { minutes: 1 }, internal.dispatcher.dispatchTick, {});

export default crons;
