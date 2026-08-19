import type { Suggestion } from "../lib/suggestions";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

/**
 * The row of what to do next, above the composer.
 *
 * Chips rather than a menu, and above the composer rather than in a panel, because this is the one
 * place a person's attention already is at the moment the question "what now?" arrives — the
 * instant a turn ends and the cursor is back. A panel on the right answers the same question in a
 * place nobody is looking.
 *
 * Three rules the styling exists to serve:
 *
 * **The reason travels with the chip.** Every suggestion carries why it is here, shown on hover and
 * on focus and announced through `aria-describedby` — a Radix tooltip rather than `title`, which
 * keyboard users never see. A chip whose reason you cannot get at is a button that appeared for no
 * stated cause, and the honest response to that is to stop reading the row.
 *
 * **Recovery does not look like advice.** A way out of a failure is marked, because it is answering
 * a different question from "what next": one is a suggestion, the other is the thing standing
 * between the reader and any further work at all.
 *
 * **A guess says it is a guess.** Model-written suggestions (off by default) carry a mark, so the
 * deterministic rules never borrow their credibility for something that was generated.
 */
export function SuggestionBar({
  suggestions,
  onTake,
  label = "Suggested next",
}: {
  suggestions: readonly Suggestion[];
  onTake: (suggestion: Suggestion) => void;
  label?: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="suggestion-bar" role="group" aria-label={label}>
      <span className="suggestion-label">{label}</span>
      {suggestions.map((suggestion) => (
        <Tooltip key={suggestion.id} label={suggestion.reason} side="top">
          <Button
            variant="ghost"
            size="chip"
            className={`suggestion ${suggestion.category}`}
            onClick={() => onTake(suggestion)}
          >
            {suggestion.label}
            {suggestion.fromModel ? <span className="suggestion-guess" aria-label="suggested by the model"> ~</span> : null}
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}
