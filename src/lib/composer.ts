/**
 * What a key pressed in the composer means.
 *
 * A separate module rather than a closure inside the textarea's handler, because this one predicate
 * *is* the behaviour — everything else in that handler is `preventDefault` and a call — and it was
 * wrong in a way no type or render test could catch: only `Ctrl/Cmd+Enter` sent, so a question
 * typed and submitted the obvious way inserted a line break and went nowhere. No error, no message,
 * which reads as the app being broken rather than as the wrong chord.
 */

export type ComposerKey = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  /** True while an input method is composing — `KeyboardEvent.isComposing`. */
  isComposing?: boolean;
};

/**
 * Whether this keystroke should send the draft.
 *
 * Enter sends; Shift+Enter is a newline; Ctrl/Cmd+Enter still sends because that was the documented
 * chord and fingers learn. An Enter arriving mid-composition never sends: an IME composing
 * Japanese, Chinese or Korean uses Enter to *commit the candidate*, so treating it as submit sends
 * a half-finished word and swallows the keystroke the writer meant for the IME.
 */
export function sendsOnKey(event: ComposerKey): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  return !event.shiftKey;
}
