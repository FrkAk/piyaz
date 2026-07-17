/**
 * Pure folder-tree helpers shared by the web note tree and the MCP `list`
 * handler. No `server-only` and no data-layer imports, so both the client
 * (`components/workspace/notes`) and the server (`lib/data`, `lib/graph`)
 * import the same derivation and cannot drift.
 */

/**
 * Normalize a folder path: split on `/`, trim each segment, drop empties.
 * `""` is root. Pure segment normalization with no length enforcement; the
 * data layer applies the length cap and its `NoteValidationError`.
 *
 * @param raw - Caller-supplied folder path.
 * @returns Canonical path (`""` = root).
 */
export function normalizeFolderPath(raw: string): string {
  return raw
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join("/");
}

/**
 * Union note-derived folder paths with explicit marker paths and synthesize
 * every ancestor, so a note at `a/b/c` yields the full `a`, `a/b`, `a/b/c`
 * chain even when no note sits directly in the ancestors. The single
 * implementation the web tree and the MCP `list` handler share, so humans
 * and agents see the same structure. Root (`""`) is never a tree node;
 * callers render root notes separately.
 *
 * @param notePaths - Folder paths from live notes (may include `""`).
 * @param markerPaths - Explicitly-created empty-folder paths.
 * @returns Sorted distinct folder paths with all ancestors, excluding `""`.
 */
export function folderTree(
  notePaths: readonly string[],
  markerPaths: readonly string[],
): string[] {
  const set = new Set<string>();
  for (const path of [...notePaths, ...markerPaths]) {
    if (path === "") continue;
    let acc = "";
    for (const segment of path.split("/")) {
      acc = acc === "" ? segment : `${acc}/${segment}`;
      set.add(acc);
    }
  }
  return [...set].sort();
}
