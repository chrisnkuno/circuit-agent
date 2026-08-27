import { useEffect, useMemo, useState } from "react";
import { getTools, type ToolSummary } from "../lib/ipc";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

/** The desktop equivalent of `/tools`: what this exact session can call, and where it came from. */
export function ToolsPanel(props: { open: boolean; onClose: () => void; tabId?: string }) {
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [hooks, setHooks] = useState<{ preToolUse: string[]; postToolUse: string[] }>({ preToolUse: [], postToolUse: [] });
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!props.open || !props.tabId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getTools(props.tabId)
      .then((result) => {
        if (cancelled) return;
        setTools(result.tools);
        setProviders(result.providerIds);
        setHooks(result.hooks);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open, props.tabId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tools;
    return tools.filter((tool) => `${tool.name} ${tool.description} ${tool.provenance.kind} ${tool.provenance.providerId ?? ""}`.toLowerCase().includes(needle));
  }, [query, tools]);

  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <DialogContent className="tools-modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Tools available in this session</DialogTitle>
          <DialogClose asChild><button className="btn ghost" type="button">Close</button></DialogClose>
        </DialogHeader>
        <input
          className="file-search"
          type="search"
          placeholder="Filter tools, skills, plugins or MCP servers…"
          aria-label="Filter tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        {loading ? <p className="panel-empty">Reading the project toolchain…</p> : null}
        {error ? <p className="notice danger" role="alert">{error}</p> : null}
        {!loading && !error ? (
          <div className="tools-summary">
            <span>{tools.length} tools</span>
            <span>{providers.length ? `Extensions: ${providers.join(", ")}` : "Built-ins only"}</span>
            <span>{hooks.preToolUse.length + hooks.postToolUse.length} hooks</span>
          </div>
        ) : null}
        <ul className="tools-list">
          {shown.map((tool) => (
            <li key={`${tool.provenance.kind}:${tool.provenance.providerId ?? "core"}:${tool.name}`}>
              <div className="tool-heading">
                <strong>{tool.name}</strong>
                <span>{tool.provenance.kind === "built-in" ? "Nova" : `${tool.provenance.kind} · ${tool.provenance.providerId}`}</span>
                <span>{tool.effect}{tool.requiresApproval ? " · approval" : ""}</span>
              </div>
              <p>{tool.description}</p>
            </li>
          ))}
        </ul>
        {!loading && !error && shown.length === 0 ? <p className="panel-empty">No tool matches “{query}”.</p> : null}
      </DialogContent>
    </Dialog>
  );
}
