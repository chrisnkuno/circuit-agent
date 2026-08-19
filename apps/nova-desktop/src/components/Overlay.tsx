import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Anything that floats above the window: dialogs, and the model menu.
 *
 * It renders through a portal into `document.body` rather than where it is written, and that is the
 * whole point. A floating element is at the mercy of every ancestor it happens to sit inside: a
 * `transform`, a `filter`, a `backdrop-filter` or a `contain` anywhere above it changes what it is
 * positioned against and which layer it composites into. That is not hypothetical here — the model
 * menu was a child of the top bar, the bar carried `backdrop-filter: blur(10px)`, and the menu was
 * drawn *through*: the transcript and the Stop button showed straight through the list of models.
 *
 * Removing that blur fixed the symptom. This removes the cause, for every overlay, permanently:
 * nothing above them in the tree can reach them any more. It is the one thing a headless component
 * library would genuinely have bought us, and it is twenty lines.
 *
 * Escape is handled here too, so every overlay in the window closes the same way — with one
 * exception the caller can ask for: the approval dialog treats Escape as a *denial*, not a
 * dismissal, because a dialog that vanishes while the agent is still waiting is a hang with no
 * visible cause.
 */
export function Overlay(props: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  /** Set when the dialog answers Escape itself, so it is not also closed from here. */
  ownsEscape?: boolean;
  /** A label for the scrim, for anything that is not a labelled dialog. */
  className?: string;
}) {
  const { open, onClose, ownsEscape } = props;

  useEffect(() => {
    if (!open || ownsEscape || !onClose) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, ownsEscape, onClose]);

  if (!open) return null;
  // Guarded so the component can be rendered in a test environment without a document.
  if (typeof document === "undefined") return null;
  return createPortal(<div className={props.className}>{props.children}</div>, document.body);
}
