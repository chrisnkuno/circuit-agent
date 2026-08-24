import { promises as fs } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const reliability = path.join(repo, "reliability");
const reportsDirectory = path.join(reliability, "reports");
const current = JSON.parse(
  await fs.readFile(path.join(reliability, "latest.json"), "utf8"),
);
const reports = [path.join(reliability, "latest.json")];
for (const name of await fs.readdir(reportsDirectory).catch(() => [])) {
  if (name.endsWith(".json")) reports.push(path.join(reportsDirectory, name));
}
const parsed = await Promise.all(
  reports.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))),
);
const valid = parsed
  .filter((report) => typeof report.score === "number")
  .sort((left, right) => right.score - left.score);
const catalog = JSON.parse(
  await fs.readFile(path.join(reliability, "catalog.json"), "utf8"),
);
const exa = await fs
  .readFile(path.join(reliability, "exa", "latest.json"), "utf8")
  .then((value) => JSON.parse(value))
  .catch(() => null);
const errors = await fs
  .readFile(path.join(reliability, "errors.json"), "utf8")
  .then((value) => JSON.parse(value))
  .catch(() => []);
const score = Math.max(
  0,
  Math.min(100, Math.round(Number(current.score) || 0)),
);
const badgeColor =
  score >= 90
    ? "brightgreen"
    : score >= 75
      ? "green"
      : score >= 60
        ? "yellow"
        : "critical";
await fs.writeFile(
  path.join(reliability, "site", "badge.json"),
  `${JSON.stringify({ schemaVersion: 1, label: "Nova reliability", message: `${score}/100`, color: badgeColor })}\n`,
);
await fs.writeFile(
  path.join(reliability, "site", "data.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), current, reports: valid, catalog, exa, errors }, null, 2)}\n`,
);
