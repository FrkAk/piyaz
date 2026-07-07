/** One `[[` link-picker suggestion (a note or a task). */
export type LinkSuggestion = {
  /** Stable candidate id (`note-<id>` / `task-<id>`). */
  id: string;
  /** Display title, ranked against the query. */
  title: string;
  /** Text inserted at the caret when picked. */
  insert: string;
  /** Accent color for the row glyph. */
  color: string;
  /** Trailing hint (note type label or task ref). */
  hint: string;
};

/** Max `[[` autocomplete suggestions kept after ranking; the list scrolls. */
export const WIKI_SUGGESTION_CAP = 50;

/** No-match sentinel rank, dropped before display. */
const RANK_NONE = 3;

/**
 * Relevance rank of a title against a lowercased query: 0 exact, 1 prefix,
 * 2 substring, 3 no match. An empty query ranks every candidate equally so
 * the picker opens with a stable, complete list.
 *
 * @param title - Candidate title.
 * @param query - Lowercased, trimmed query.
 * @returns Rank in `[0, 3]`.
 */
function titleRank(title: string, query: string): number {
  if (query === "") return 2;
  const t = title.toLowerCase();
  if (t === query) return 0;
  if (t.startsWith(query)) return 1;
  if (t.includes(query)) return 2;
  return RANK_NONE;
}

/**
 * Filter `[[` link candidates to those matching the query, rank by
 * relevance (exact > prefix > substring, alphabetical tie-break), and cap.
 * Notes and tasks share one pool so tasks are never starved by notes.
 *
 * @param query - Raw query typed after `[[`.
 * @param candidates - Merged note + task candidates.
 * @param cap - Maximum results to return.
 * @returns Ranked, capped suggestions.
 */
export function rankLinkSuggestions(
  query: string,
  candidates: readonly LinkSuggestion[],
  cap = WIKI_SUGGESTION_CAP,
): LinkSuggestion[] {
  const q = query.trim().toLowerCase();
  return candidates
    .map((suggestion) => ({ suggestion, rank: titleRank(suggestion.title, q) }))
    .filter((entry) => entry.rank < RANK_NONE)
    .sort(
      (a, b) =>
        a.rank - b.rank || a.suggestion.title.localeCompare(b.suggestion.title),
    )
    .slice(0, cap)
    .map((entry) => entry.suggestion);
}
