import { useEffect, useMemo, useRef, useState } from "react";
import { buildModelOptions, filterModels } from "../lib/models";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import type { ProviderId } from "../lib/settings";

/**
 * Switching model without leaving the conversation.
 *
 * Arrow keys and a filter, matching the CLI's picker, so the two surfaces behave the same way. The
 * current model is what the button shows — a status readout and the control for changing it in one
 * place, rather than a value buried in a settings form you have to open to read.
 */
export function ModelPicker(props: {
  provider: ProviderId;
  model: string;
  busy: boolean;
  /** Providers that actually have a key. Rows for the others say so and lead to Settings. */
  configured?: ReadonlySet<ProviderId>;
  onPick: (provider: ProviderId, model: string) => void;
  /** Where a row with no key sends you — choosing it should fix the problem, not report it. */
  onNeedsKey?: (provider: ProviderId) => void;
  /** Controlled by the parent so a keyboard shortcut can open it too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { open } = props;
  const setOpen = (next: boolean | ((current: boolean) => boolean)) =>
    props.onOpenChange(typeof next === "function" ? next(props.open) : next);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(
    () => buildModelOptions(props.configured ?? props.provider),
    [props.configured, props.provider],
  );
  const visible = useMemo(() => filterModels(options, query), [options, query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    setCursor(Math.max(0, visible.findIndex((option) => option.model === props.model && option.provider === props.provider)));
    // Opening on the model in use makes the common case "look, then Escape".
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Radix closes on an outside click, on Escape and on a focus escape, so the hand-rolled
  // click-away listener this used to carry has gone with it.

  function onKeyDown(event: React.KeyboardEvent) {
    // The same handler is bound to the filter input and to the menu around it, so that arrow keys
    // work whether focus sits in the field or on an option. Without this, a key pressed in the
    // field runs it twice — once on the input, once on the way up — and Enter therefore switched
    // model twice: two `model.set` calls, two session rebuilds, and the switch recorded twice in
    // the transcript for one keypress.
    event.stopPropagation();
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((c) => Math.min(visible.length - 1, c + 1)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = visible[cursor];
      if (!chosen) return;
      setOpen(false);
      if (chosen.needsKey) { props.onNeedsKey?.(chosen.provider); return; }
      if (chosen.provider !== props.provider || chosen.model !== props.model) props.onPick(chosen.provider, chosen.model);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="btn ghost model-trigger"
          type="button"
          disabled={props.busy}
          title="Switch model — the conversation carries over"
        >
          <span className="model-name">{props.model}</span>
          <span className="model-caret" aria-hidden="true">▾</span>
        </button>
      </PopoverTrigger>

      <PopoverContent className="model-menu" role="listbox" aria-label="Models" onKeyDown={onKeyDown}>
        <div className="model-menu-inner">
          <input
            ref={inputRef}
            className="model-filter"
            value={query}
            placeholder="Filter models…"
            aria-label="Filter models"
            onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
          />
          <div className="model-list">
            {visible.length === 0 ? <p className="panel-empty">No model matches “{query}”.</p> : null}
            {visible.map((option, index) => {
              const current = option.model === props.model && option.provider === props.provider;
              return (
                <button
                  key={`${option.provider}/${option.model}`}
                  className={`model-option${index === cursor ? " cursor" : ""}${current ? " current" : ""}`}
                  role="option"
                  aria-selected={current}
                  type="button"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => {
                    setOpen(false);
                    if (option.needsKey) { props.onNeedsKey?.(option.provider); return; }
                    if (!current) props.onPick(option.provider, option.model);
                  }}
                >
                  <span className="model-option-name">{option.model}</span>
                  <span className="model-option-meta">
                    {option.providerLabel}
                    {option.price ? ` · ${option.price}` : " · unpriced"}
                    {current ? " · current" : ""}
                    {option.needsKey ? " · needs a key" : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="model-foot">Switching keeps the conversation. Prices are list rates, not your contract.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
