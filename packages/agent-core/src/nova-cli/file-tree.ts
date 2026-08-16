/**
 * A project's file list, as a tree.
 *
 * Lives in agent-core rather than in either UI because both of them need it and neither owns it:
 * the CLI's `/files` browser draws this with box-drawing connectors, the desktop draws it with
 * nested elements, and the shape underneath — what is a folder, what sorts before what — is the
 * same question in both. It was already answered twice in this repo before it was answered once
 * here, and every type that has been copied between those two surfaces has since drifted.
 *
 * Pure data: no rendering, no terminal, no DOM. The only input is the flat, root-relative,
 * forward-slashed path list every backend's `glob` already returns.
 */

export type FileNode = {
  name: string;
  /** Root-relative, forward-slashed — the same shape `workspace.glob` returns. */
  path: string;
  kind: "dir" | "file";
  children: FileNode[];
};

/** Builds the tree from a flat file list. */
export function buildFileTree(paths: readonly string[]): FileNode[] {
  const root: FileNode = { name: "", path: "", kind: "dir", children: [] };
  for (const raw of paths) {
    const parts = raw.split("/").filter((part) => part.length > 0);
    let node = root;
    let built = "";
    for (const [index, part] of parts.entries()) {
      built = built ? `${built}/${part}` : part;
      const isFile = index === parts.length - 1;
      let child = node.children.find((candidate) => candidate.name === part);
      if (!child) {
        child = { name: part, path: built, kind: isFile ? "file" : "dir", children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  sortTree(root);
  return root.children;
}

/** Folders before files, each group alphabetical — the ordering `ls` already implies. */
function sortTree(node: FileNode): void {
  node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  for (const child of node.children) sortTree(child);
}

/**
 * How many files and folders a directory holds, directly or nested.
 *
 * A folder has no content of its own to preview, and "what is in here" is the question its row is
 * actually asking, so the count stands in for one.
 */
export function directorySummary(node: FileNode): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  for (const child of node.children) {
    if (child.kind === "file") files += 1;
    else {
      dirs += 1;
      const nested = directorySummary(child);
      files += nested.files;
      dirs += nested.dirs;
    }
  }
  return { files, dirs };
}
