/**
 * Turning an assistant's text into things a reader can use.
 *
 * The transcript was one `white-space: pre-wrap` block per message, which for a *coding* agent is
 * the wrong default: its most valuable output is code, and code rendered as prose is code you
 * cannot read, cannot tell apart from the sentence above it, and cannot copy without selecting it
 * by hand. Splitting on fences is the smallest change that fixes all three.
 *
 * Kept as pure functions rather than done inside the component so it can be tested without a DOM —
 * the same split this repo already uses for the CLI's menus, where the state machine is tested
 * directly and the terminal only proves the keys arrive.
 */

export type TranscriptSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; language: string | undefined; code: string };

const FENCE = /^```([^\n`]*)\n?/;

/**
 * Splits text into prose and fenced code blocks.
 *
 * An unterminated fence still yields a code block. A model streams its answer, so the *common*
 * case mid-turn is a fence that has been opened and not yet closed — treating that as prose would
 * make code flicker from unformatted to formatted as the closing fence lands.
 */
export function splitSegments(text: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let rest = text;
  let prose = "";

  const flushProse = () => {
    if (prose.trim()) segments.push({ kind: "text", text: prose.replace(/\n+$/, "") });
    prose = "";
  };

  while (rest.length > 0) {
    const start = rest.indexOf("```");
    if (start === -1) { prose += rest; break; }
    prose += rest.slice(0, start);
    const afterFence = rest.slice(start);
    const opener = FENCE.exec(afterFence);
    if (!opener) { prose += afterFence; break; }
    const body = afterFence.slice(opener[0].length);
    const end = body.indexOf("```");
    flushProse();
    segments.push({
      kind: "code",
      language: opener[1].trim() || undefined,
      code: (end === -1 ? body : body.slice(0, end)).replace(/\n$/, ""),
    });
    rest = end === -1 ? "" : body.slice(end + 3).replace(/^\n/, "");
  }
  flushProse();
  return segments;
}

/**
 * Whether the transcript should follow new output.
 *
 * It used to scroll to the bottom on every message unconditionally, which makes reading anything
 * during a turn impossible — you scroll up, the next token yanks you back down. Following only
 * when the reader is already near the bottom is the rule every chat client settles on: scrolling
 * away is an explicit act, and it should be respected until the reader comes back.
 */
export function shouldFollow(view: { scrollTop: number; scrollHeight: number; clientHeight: number }, slackPx = 120): boolean {
  return view.scrollHeight - (view.scrollTop + view.clientHeight) <= slackPx;
}
