import { useEffect, useMemo, useState } from "react";
import { listFiles } from "../lib/ipc";
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
 */
export function FilePanel(props: { open: boolean; onClose: () => void; onPick: (path: string) => void }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFiles()
      .then((result) => { if (!cancelled) setPaths(result.files ?? []); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
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

  const pick = (path: string): void => {
    props.onPick(path);
    props.onClose();
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
              <button className="file-btn" type="button" onClick={() => pick(node.path)} title={`Mention ${node.path}`}>
                <span className="file-caret" aria-hidden="true" />
                <span className="file-name">{node.name}</span>
              </button>
            )}
          </div>
          {node.kind === "dir" && isOpen ? <ul className="file-children">{renderNodes(node.children, depth + 1)}</ul> : null}
        </li>
      );
    });

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal diff-modal" role="dialog" aria-modal="true" aria-labelledby="files-title">
        <div className="approval-head">
          <h2 id="files-title">Project files</h2>
          <button className="btn ghost" type="button" onClick={props.onClose}>Close</button>
        </div>

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
                        <button className="file-btn" type="button" onClick={() => pick(match.path)} title={`Mention ${match.path}`}>
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
    </div>
  );
}
