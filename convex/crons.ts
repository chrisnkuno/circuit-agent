import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recover expired agent leases", { minutes: 1 }, internal.agentRuns.recoverExpiredLeases, { maxAttempts: 3 });

export default crons;
