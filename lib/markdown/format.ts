/**
 * Text normalization for stored task/project/edge prose. Deliberately
 * byte-preserving: text is stored exactly as written (trim only), so
 * `fields=[...]` reads, `str_replace` matching, and CAS preconditions
 * round-trip without the server rewriting agent input. Markdown rendering
 * and sanitization happen at read time (`components/shared/Markdown.tsx`,
 * ReactMarkdown + rehype-sanitize); SQL safety is parameterized queries.
 */

/**
 * Normalize markdown-bearing text for storage: trim only, never rewrite.
 * Idempotent — running twice produces the same output.
 * @param src - Raw text, null, or undefined.
 * @returns Trimmed text, or null for empty input.
 */
export async function formatMarkdown(
  src: string | null | undefined,
): Promise<string | null> {
  if (src == null) return null;
  const trimmed = src.trim();
  return trimmed || null;
}

/**
 * Map-normalize the `text` field on every item of a criteria/decisions-like array.
 * @param items - Array of objects with an optional `text` field.
 * @returns New array with trimmed text values.
 */
export async function formatTextFieldArray<T extends { text?: unknown }>(
  items: readonly T[],
): Promise<T[]> {
  return Promise.all(
    items.map(async (item) => {
      const text = item.text;
      if (typeof text !== "string" || !text.trim()) return item;
      const formatted = await formatMarkdown(text);
      return { ...item, text: formatted ?? text };
    }),
  );
}

const TASK_MARKDOWN_FIELDS = [
  "description",
  "implementationPlan",
  "executionRecord",
] as const;

/**
 * Normalize all markdown-bearing fields on a task create/update payload in place on a clone.
 * Covers `description`, `implementationPlan`, `executionRecord`, and the `.text` field
 * of each `acceptanceCriteria` / `decisions` entry.
 * @param input - Task fields to normalize.
 * @returns New object with trimmed fields.
 */
export async function formatTaskMarkdownFields<
  T extends Record<string, unknown>,
>(input: T): Promise<T> {
  const result: Record<string, unknown> = { ...input };
  for (const field of TASK_MARKDOWN_FIELDS) {
    const val = result[field];
    if (typeof val === "string" && val.trim()) {
      result[field] = (await formatMarkdown(val)) ?? val;
    }
  }
  if (Array.isArray(result.acceptanceCriteria)) {
    result.acceptanceCriteria = await formatTextFieldArray(
      result.acceptanceCriteria as { text?: unknown }[],
    );
  }
  if (Array.isArray(result.decisions)) {
    result.decisions = await formatTextFieldArray(
      result.decisions as { text?: unknown }[],
    );
  }
  return result as T;
}
