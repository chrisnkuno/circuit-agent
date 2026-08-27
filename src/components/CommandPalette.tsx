import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export type DesktopCommand = {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
};

/** Search by intent, mirroring the CLI palette without making the window pretend to be a terminal. */
export function CommandPalette(props: { open: boolean; onClose: () => void; commands: readonly DesktopCommand[] }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return props.commands;
    return props.commands.filter((command) => `${command.label} ${command.description}`.toLowerCase().includes(needle));
  }, [props.commands, query]);

  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!next) { setQuery(""); props.onClose(); } }}>
      <DialogContent className="command-palette" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Commands</DialogTitle>
        <input
          className="command-search"
          type="search"
          aria-label="Search commands"
          placeholder="What do you want to do?"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <div className="command-list" role="listbox" aria-label="Available commands">
          {shown.map((command) => (
            <button
              key={command.id}
              type="button"
              role="option"
              disabled={command.disabled}
              onClick={() => { props.onClose(); setQuery(""); command.run(); }}
            >
              <span><strong>{command.label}</strong><small>{command.description}</small></span>
              {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
            </button>
          ))}
        </div>
        {shown.length === 0 ? <p className="panel-empty">No command matches “{query}”.</p> : null}
      </DialogContent>
    </Dialog>
  );
}
