import { useEffect, useMemo, useState } from "react";
import { listFiles, readFile, type FileContents } from "../lib/ipc";
import { ancestorsOf, buildFileTree, describeFolder, searchFiles, type FileNode } from "../lib/files";

/**
 * The project, as a tree you can look around in.
 *
 * The desktop could only reference a file by having one typed at it, which is blind in the same way
 * the CLI's `@path` completion was before it grew a browser: typing `ap` never tells you there is a
 * folder called `api` you have not opened. Picking here inserts an `@path` mention into the
 * composer — the same syntax the agent already understands, so there is one convention for "this
 * file" rather than two.
 *
 * Folders expand in place; typing searches flat across the whole project, because a match three
 * folders deep is not made easier to find by nesting it three folders deep.
 *
 * Selecting a file also *shows* it, in a pane beside the tree. Until it did, the only way to read
 * a file the agent had just written was to leave for an editor and come back — which is a strange
 * thing to have to do inside the window that wrote it. The contents come from the session's
 * workspace over `files.read`, never from the local disk directly, so a sandboxed tab shows the
 * sandbox's copy: the file the agent is actually working on rather than a stale one with the same
 * name on this machine. It is also why this needs no filesystem permission in `capabilities/` —
 * the webview still cannot read anything itself.
 */
/** How much of a file the preview will pull. Enough to read a source file; not enough to hang. */
const PREVIEW_LINES = 2_000;

export function FilePanel(props: { open: boolean; onClose: () => void; onPick: (path: string) => void; tabId?: string }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [contentsError, setContentsError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFiles(undefined, props.tabId)
      .then((result) => { if (!cancelled) setPaths(result.files ?? []); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open, props.tabId]);

  useEffect(() => {
    if (!props.open || !selected) return;
    let cancelled = false;
    setReading(true);
    setContentsError(null);
    // A cap rather than the whole file: this is a look, not an editor, and a 200k-line log pasted
    // into the DOM would freeze the window it was meant to save you leaving.
    readFile(selected, props.tabId, PREVIEW_LINES)
      .then((result) => { if (!cancelled) setContents(result.file ?? null); })
      .catch((err) => { if (!cancelled) { setContents(null); setContentsError(err instanceof Error ? err.message : String(err)); } })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [props.open, props.tabId, selected]);

  useEffect(() => {
    if (props.open) return;
    // Cleared on close so reopening does not show the last project's file for the instant before
    // the new read lands.
    setSelected(null);
    setContents(null);
    setContentsError(null);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  // Rebuilding the tree on every keystroke would re-walk the whole project to render a filter that
  // does not use the tree at all.
  const tree = useMemo(() => buildFileTree(paths ?? []), [paths]);
  const matches = useMemo(() => searchFiles(tree, query), [tree, query]);

  if (!props.open) return null;

  /** Inserts `@path` into the composer and leaves — the panel's original and still-primary act. */
  const mention = (path: string): void => {
    props.onPick(path);
    props.onClose();
  };

  /** Shows a file without leaving the panel. Selecting is not mentioning: reading one file to decide
   *  whether it is the one you meant should not put it in your next message. */
  const select = (path: string): void => {
    setSelected(path);
    setContents(null);
  };

  /** Reveals a search result where it actually lives, rather than picking it blind. */
  const revealInTree = (path: string): void => {
    setExpanded((current) => new Set([...current, ...ancestorsOf(path)]));
    setQuery("");
  };

  const toggle = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: readonly FileNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isOpen = expanded.has(node.path);
      return (
        <li key={node.path} className="file-node">
          <div className="file-row" style={{ paddingLeft: `${depth * 14}px` }}>
            {node.kind === "dir" ? (
              <button className="file-btn" type="button" onClick={() => toggle(node.path)} aria-expanded={isOpen}>
                <span className="file-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                <span className="file-name">{node.name}/</span>
                <span className="file-meta">{describeFolder(node)}</span>
              </button>
            ) : (
              <>
                <button
                  className={`file-btn${selected === node.path ? " selected" : ""}`}
                  type="button"
                  onClick={() => select(node.path)}
                  aria-current={selected === node.path ? "true" : undefined}
                  title={`Show ${node.path}`}
                >
                  <span className="file-caret" aria-hidden="true" />
                  <span className="file-name">{node.name}</span>
                </button>
                <button className="btn ghost tiny" type="button" onClick={() => mention(node.path)} title={`Mention ${node.path}`}>
                  Mention
                </button>
              </>
            )}
          </div>
          {node.kind === "dir" && isOpen ? <ul className="file-children">{renderNodes(node.children, depth + 1)}</ul> : null}
        </li>
      );
    });

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal diff-modal file-explorer" role="dialog" aria-modal="true" aria-labelledby="files-title">
        <div className="approval-head">
          <h2 id="files-title">Project files</h2>
          <button className="btn ghost" type="button" onClick={props.onClose}>Close</button>
        </div>

        <div className="file-explorer-panes">
        <div className="file-explorer-tree">

        <input
          className="file-search"
          type="search"
          placeholder="Search files…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search files"
          autoFocus
        />

        {loading ? <p className="panel-empty">Reading the project…</p> : null}
        {error ? <div className="notice danger" role="alert"><span>{error}</span></div> : null}

        {paths && !loading && !error ? (
          query.trim() !== "" ? (
            matches.length === 0
              ? <p className="panel-empty">Nothing matches “{query}”.</p>
              : (
                <ul className="file-tree">
                  {matches.map((match) => (
                    <li key={match.path} className="file-node">
                      <div className="file-row">
                        <button
                          className={`file-btn${selected === match.path ? " selected" : ""}`}
                          type="button"
                          onClick={() => select(match.path)}
                          aria-current={selected === match.path ? "true" : undefined}
                          title={`Show ${match.path}`}
                        >
                          <span className="file-name">{match.path}</span>
                        </button>
                        <button className="btn ghost tiny" type="button" onClick={() => revealInTree(match.path)}>
                          Reveal
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
          ) : (
            tree.length === 0
              ? <p className="panel-empty">No files found in this project.</p>
              : <ul className="file-tree">{renderNodes(tree, 0)}</ul>
          )
        ) : null}
        </div>

        <div className="file-preview" aria-live="polite">
          {selected === null ? (
            <p className="panel-empty">Pick a file to read it here.</p>
          ) : (
            <>
              <div className="file-preview-head">
                <span className="file-preview-path" title={selected}>{selected}</span>
                <button className="btn ghost tiny" type="button" onClick={() => mention(selected)}>
                  Mention in composer
                </button>
              </div>
              {reading ? <p className="panel-empty">Reading {selected}…</p> : null}
              {contentsError ? <div className="notice danger" role="alert"><span>{contentsError}</span></div> : null}
              {contents && !reading && !contentsError ? (
                <>
                  <pre className="file-preview-body"><code>{contents.content}</code></pre>
                  <p className="file-preview-foot">
                    {contents.truncated
                      ? `First ${PREVIEW_LINES.toLocaleString()} of ${contents.totalLines.toLocaleString()} lines — open it in your editor for the rest.`
                      : `${contents.totalLines.toLocaleString()} ${contents.totalLines === 1 ? "line" : "lines"}`}
                  </p>
                </>
              ) : null}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
