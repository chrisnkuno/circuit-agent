import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recover expired agent leases", { minutes: 1 }, internal.agentRuns.recoverExpiredLeases, { maxAttempts: 3 });
crons.interval("claim due Google Calendar schedules", { minutes: 5 }, internal.googleCalendar.runDueSchedules, {});
// Overlapping ticks are safe: claimStep transitions a step out of pending/ready exactly once
// and reports "not_claimable" to every tick that loses the race, so the loser skips that step
// and keeps going instead of failing the whole tick.
crons.interval("dispatch queued coding work", { minutes: 1 }, internal.dispatcher.dispatchTick, {});
crons.interval("claim due coding-task schedules", { minutes: 1 }, internal.scheduledRuns.runDueCodingSchedules, {});

export default crons;
