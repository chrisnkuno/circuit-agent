/**
 * A scrollable window over more lines than fit — Nova's answer to Bubbles' `viewport`.
 *
 * Three screens had grown their own version of this (the guide's body, the file view, the
 * transcript), each with its own idea of what `pagedown` means at the end of the content and its
 * own off-by-one at the bottom. The bugs that produces are the quiet kind: a last line that can
 * never be reached, or a page key that scrolls past the end and shows an empty screen, and both
 * look like the content is missing rather than like the scroller is wrong.
 *
 * State and behaviour only — no keys are read and nothing is printed here. The screens keep their
 * own key maps and their own rendering; what they share is the arithmetic, which is the part that
 * has one correct answer.
 */

export type ViewportState = {
  /** Every line of content, unwrapped by the caller to the width it renders at. */
  lines: readonly string[];
  /** Rows the window shows at once. */
  height: number;
  /** First visible line. Always within range: see `clampTop`. */
  top: number;
};

export type ViewportAction =
  | { kind: "up"; rows?: number }
  | { kind: "down"; rows?: number }
  | { kind: "halfUp" }
  | { kind: "halfDown" }
  | { kind: "pageUp" }
  | { kind: "pageDown" }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "resize"; height: number }
  | { kind: "content"; lines: readonly string[]; follow?: boolean };

export function newViewport(lines: readonly string[], height: number): ViewportState {
  return clamp({ lines, height: Math.max(1, Math.floor(height)), top: 0 });
}

/** The furthest first-line that still fills the window — zero when the content is shorter than it. */
export function maxTop(state: ViewportState): number {
  return Math.max(0, state.lines.length - state.height);
}

function clamp(state: ViewportState): ViewportState {
  const height = Math.max(1, Math.floor(state.height));
  const bounded = { ...state, height };
  const top = Math.max(0, Math.min(Math.floor(bounded.top) || 0, maxTop(bounded)));
  return { ...bounded, top };
}

export function applyViewport(state: ViewportState, action: ViewportAction): ViewportState {
  switch (action.kind) {
    case "up":
      return clamp({ ...state, top: state.top - Math.max(1, action.rows ?? 1) });
    case "down":
      return clamp({ ...state, top: state.top + Math.max(1, action.rows ?? 1) });
    case "halfUp":
      return clamp({ ...state, top: state.top - Math.max(1, Math.floor(state.height / 2)) });
    case "halfDown":
      return clamp({ ...state, top: state.top + Math.max(1, Math.floor(state.height / 2)) });
    // A page keeps one row of overlap, so the line you were reading when you pressed the key is
    // still on screen afterwards. A clean jump of exactly one screen loses your place at the seam.
    case "pageUp":
      return clamp({ ...state, top: state.top - Math.max(1, state.height - 1) });
    case "pageDown":
      return clamp({ ...state, top: state.top + Math.max(1, state.height - 1) });
    case "top":
      return clamp({ ...state, top: 0 });
    case "bottom":
      return clamp({ ...state, top: maxTop(state) });
    case "resize":
      // Anchored at the top of the window rather than the middle: a terminal being dragged wider
      // should not scroll the text the reader is looking at.
      return clamp({ ...state, height: action.height });
    case "content": {
      // `follow` is the tail behaviour a log needs — new lines arriving keep the view pinned to the
      // end — and is deliberately not the default: a reader who has scrolled up to look at
      // something must not be yanked away from it by output arriving underneath.
      const next = clamp({ ...state, lines: action.lines });
      return action.follow ? clamp({ ...next, top: maxTop(next) }) : next;
    }
  }
}

/** Exactly the lines on screen: never more than `height`, and never past the end of the content. */
export function visibleLines(state: ViewportState): string[] {
  return state.lines.slice(state.top, state.top + state.height);
}

export function atTop(state: ViewportState): boolean {
  return state.top <= 0;
}

export function atBottom(state: ViewportState): boolean {
  return state.top >= maxTop(state);
}

/**
 * How far down the content the window sits, 0 to 1.
 *
 * Content that fits reports 1 rather than 0: there is nothing below, which is what "you are at the
 * bottom" means, and a scroll indicator reading "Top" beside a fully visible page is a lie about
 * there being more.
 */
export function scrollFraction(state: ViewportState): number {
  const furthest = maxTop(state);
  return furthest === 0 ? 1 : state.top / furthest;
}
