import { buildFileTree, directorySummary, type FileNode } from "@circuit-nova/nova-core/nova-cli/file-tree";

/**
 * What the file panel needs on top of the shared tree.
 *
 * The tree itself — what is a folder, what sorts before what — is agent-core's, and is the same
 * structure the CLI's `/files` draws. Only the parts that differ because this is a DOM live here:
 * HTML nests, so there are no connector glyphs to compute, and search returns flat rows the way
 * every fuzzy finder does rather than a pruned tree.
 */

export { buildFileTree, directorySummary, type FileNode };

/** A match, with enough context to render a row: the file, and where it sits. */
export type FileMatch = { node: FileNode; path: string };

/**
 * Files whose path contains the query, case-insensitively, flattened.
 *
 * Flat on purpose. A match three folders deep is not made easier to find by nesting it three
 * folders deep, and preserving the tree while filtering means drawing folders that exist only to
 * hold one result — which is most of the screen for a narrow query.
 *
 * Folders are never returned. The panel's job is picking a *file*, so offering a folder as a
 * result would produce a selection the caller cannot use.
 */
export function searchFiles(tree: readonly FileNode[], query: string, limit = 200): FileMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const found: FileMatch[] = [];
  const walk = (nodes: readonly FileNode[]): void => {
    for (const node of nodes) {
      if (found.length >= limit) return;
      if (node.kind === "file") {
        if (node.path.toLowerCase().includes(needle)) found.push({ node, path: node.path });
      } else walk(node.children);
    }
  };
  walk(tree);
  return found;
}

/**
 * The set of folder paths that must be open for `path` to be visible.
 *
 * Used to reveal a search result in the tree: picking `src/deep/util.ts` out of a flat result list
 * and then showing it in a tree that still has `src/` collapsed would be showing it nowhere.
 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const ancestors: string[] = [];
  let built = "";
  // Every part except the last, which is the file itself and has nothing to expand.
  for (const part of parts.slice(0, -1)) {
    built = built ? `${built}/${part}` : part;
    ancestors.push(built);
  }
  return ancestors;
}

/** Bytes-free description of a folder's contents, for a row that has no preview of its own. */
export function describeFolder(node: FileNode): string {
  const { files, dirs } = directorySummary(node);
  const filePart = `${files} file${files === 1 ? "" : "s"}`;
  return dirs === 0 ? filePart : `${dirs} folder${dirs === 1 ? "" : "s"}, ${filePart}`;
}
