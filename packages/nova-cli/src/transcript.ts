/**
 * How a tool call reads in the transcript.
 *
 * A bare tool name is the least useful thing that could be printed: `read_file` tells you nothing,
 * `read_file src/app.ts` tells you everything. The argument that matters differs per tool, so it is
 * named per tool rather than guessed by printing the whole JSON payload — which for `write_file`
 * would dump the entire file into the transcript.
 *
 * Pure string functions only; the writing and the in-place line upgrades live in `tui.ts`.
 */

/** Shortens a value to fit a line without hiding which end was cut. */
export function truncateMiddle(value: string, maximum: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maximum) return clean;
  if (maximum <= 1) return clean.slice(0, Math.max(0, maximum));
  // Paths and commands carry their meaning at both ends — `src/…/app.ts` and `npm run …--watch`
  // are both more useful than a prefix that stops before the interesting part.
  const head = Math.ceil((maximum - 1) / 2);
  const tail = Math.floor((maximum - 1) / 2);
  return `${clean.slice(0, head)}…${tail > 0 ? clean.slice(-tail) : ""}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * The one thing worth showing about a call, chosen per tool.
 *
 * Returns an empty string when a tool genuinely has no interesting argument (`todo_read`), rather
 * than inventing one — an empty detail renders as just the tool name, which is correct there.
 */
export function describeToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file": {
      const path = asString(args.path) ?? "";
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (offset === undefined) return path;
      // A ranged read is a different act from reading a whole file; say which lines.
      return limit === undefined ? `${path}:${offset}+` : `${path}:${offset}-${offset + limit - 1}`;
    }
    case "write_file":
    case "edit_file":
      return asString(args.path) ?? "";
    case "list_files":
      return asString(args.path) ?? ".";
    case "glob_files":
      return asString(args.pattern) ?? "";
    case "grep_files": {
      const query = asString(args.query) ?? "";
      const include = asString(args.include);
      return include ? `"${query}" in ${include}` : `"${query}"`;
    }
    case "run_command":
      return asString(args.command) ?? "";
    case "web_search":
      return `"${asString(args.query) ?? ""}"`;
    case "web_fetch":
      return asString(args.url) ?? "";
    case "todo_write": {
      if (Array.isArray(args.items)) return `${args.items.length} step${args.items.length === 1 ? "" : "s"}`;
      const parts: string[] = [];
      const started = countOf(args.start);
      const completed = countOf(args.complete);
      if (started > 0) parts.push(`${started} started`);
      if (completed > 0) parts.push(`${completed} done`);
      return parts.join(", ");
    }
    default: {
      // An unknown tool still deserves a useful line, so the first string argument stands in.
      const first = Object.values(args).find((value) => typeof value === "string" && value.trim() !== "");
      return typeof first === "string" ? first.trim() : "";
    }
  }
}

function lineCount(content: string): number {
  const trimmed = content.replace(/\n+$/, "");
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

/**
 * What the call produced, in as few words as carry the meaning.
 *
 * The full result already went to the model; the person watching needs the shape of it — how many
 * matches, whether the command passed — and can ask for the content if they want it.
 */
export function summarizeToolResult(toolName: string, content: string, isError: boolean): string {
  const body = content ?? "";
  switch (toolName) {
    case "run_command": {
      const exit = /^exit (\d+)/.exec(body);
      if (!exit) return truncateMiddle(body.split("\n")[0] ?? "", 60);
      const code = Number(exit[1]);
      if (code === 0) return "exit 0";
      // A failing command's first line of output is the only part anyone reads first.
      const detail = body.split("\n").slice(1).find((line) => line.trim() !== "");
      return detail ? `exit ${code} · ${truncateMiddle(detail, 48)}` : `exit ${code}`;
    }
    case "grep_files": {
      if (/^No matches/i.test(body)) return "no matches";
      const matches = lineCount(body);
      return `${matches} match${matches === 1 ? "" : "es"}`;
    }
    case "glob_files": {
      if (/^No files matched/i.test(body)) return "no files";
      const files = lineCount(body);
      return `${files} file${files === 1 ? "" : "s"}`;
    }
    case "list_files": {
      const entries = lineCount(body);
      return `${entries} entr${entries === 1 ? "y" : "ies"}`;
    }
    case "read_file": {
      const lines = lineCount(body);
      return `${lines} line${lines === 1 ? "" : "s"}`;
    }
    case "write_file":
    case "edit_file":
      // These tools already report exactly what they did; restating it would only lose detail.
      return truncateMiddle(body.split("\n")[0] ?? "", 60);
    case "todo_write":
    case "todo_read": {
      const done = (body.match(/^\[x\]/gm) ?? []).length;
      const total = (body.match(/^\[[ x~]\]/gm) ?? []).length;
      return total > 0 ? `${done}/${total} done` : truncateMiddle(body.split("\n")[0] ?? "", 40);
    }
    default: {
      const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
      return truncateMiddle(first, isError ? 60 : 48);
    }
  }
}
