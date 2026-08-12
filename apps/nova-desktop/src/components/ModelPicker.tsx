import { useEffect, useMemo, useRef, useState } from "react";
import { buildModelOptions, filterModels } from "../lib/models";
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
  onPick: (provider: ProviderId, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => buildModelOptions(props.provider), [props.provider]);
  const visible = useMemo(() => filterModels(options, query), [options, query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    setCursor(Math.max(0, visible.findIndex((option) => option.model === props.model && option.provider === props.provider)));
    // Opening on the model in use makes the common case "look, then Escape".
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onClickAway = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClickAway);
    return () => window.removeEventListener("mousedown", onClickAway);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((c) => Math.min(visible.length - 1, c + 1)); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = visible[cursor];
      if (!chosen) return;
      setOpen(false);
      if (chosen.provider !== props.provider || chosen.model !== props.model) props.onPick(chosen.provider, chosen.model);
    }
  }

  return (
    <div className="model-picker" ref={boxRef}>
      <button
        className="btn ghost model-trigger"
        type="button"
        disabled={props.busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Switch model — the conversation carries over"
      >
        <span className="model-name">{props.model}</span>
        <span className="model-caret" aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div className="model-menu" role="listbox" aria-label="Models" onKeyDown={onKeyDown}>
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
                    if (!current) props.onPick(option.provider, option.model);
                  }}
                >
                  <span className="model-option-name">{option.model}</span>
                  <span className="model-option-meta">
                    {option.providerLabel}
                    {option.price ? ` · ${option.price}` : " · unpriced"}
                    {current ? " · current" : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="model-foot">Switching keeps the conversation. Prices are list rates, not your contract.</p>
        </div>
      ) : null}
    </div>
  );
}
