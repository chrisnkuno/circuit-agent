const ranges = [{ min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 }, { min: 1, max: 12 }, { min: 0, max: 6 }];

export function validateCronExpression(expression: string): string[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return ["Cron expression must contain exactly five fields"];
  const issues: string[] = [];
  fields.forEach((field, index) => {
    if (field === "*") return;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) {
      const value = Number(step[1]);
      if (!Number.isInteger(value) || value < 1 || value > ranges[index].max) issues.push(`Invalid cron step ${field}`);
      return;
    }
    for (const part of field.split(",")) {
      const value = Number(part);
      if (!Number.isInteger(value) || value < ranges[index].min || value > ranges[index].max) issues.push(`Invalid cron value ${part}`);
    }
  });
  return issues;
}

export function nextCronOccurrence(expression: string, timezone: string, after: number): number {
  const issues = validateCronExpression(expression);
  if (issues.length) throw new Error(issues.join("; "));
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(after)); } catch { throw new Error("Schedule timezone is invalid"); }
  const fields = expression.trim().split(/\s+/);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" });
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = candidate + 370 * 24 * 60 * 60_000;
  for (; candidate <= limit; candidate += 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const values = [Number(parts.minute), Number(parts.hour), Number(parts.day), Number(parts.month), weekdays[parts.weekday]];
    if (fields.every((field, index) => cronFieldMatches(field, values[index], ranges[index].min))) return candidate;
  }
  throw new Error("Cron expression has no occurrence in the next 370 days");
}

function cronFieldMatches(field: string, value: number, minimum: number): boolean {
  if (field === "*") return true;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) return (value - minimum) % Number(step[1]) === 0;
  return field.split(",").some((candidate) => Number(candidate) === value);
}
