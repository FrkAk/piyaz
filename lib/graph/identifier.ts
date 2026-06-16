/**
 * Project identifier helpers for human-readable task references (e.g. "MYM-123").
 *
 * The composed taskRef is `{project.identifier}-{task.sequenceNumber}` — computed
 * at read time, not stored. This module owns both the prefix shape and the
 * taskRef composition.
 */

import { z } from "zod/v4";

/** Branded project identifier — 2-12 uppercase letters or digits. */
export type Identifier = string & { readonly __brand: "Identifier" };

/** Branded composed task reference (e.g. "MYM-123"). */
export type TaskRef = string & { readonly __brand: "TaskRef" };

/** Discriminated parse result. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Canonical shape rule for project identifiers. Shared across Zod schemas and manual parsing. */
const IDENTIFIER_PATTERN = /^[A-Z0-9]{2,12}$/;

/** Zod schema for a project identifier (2-12 uppercase letters or digits). */
export const identifierSchema = z
  .string()
  .regex(
    IDENTIFIER_PATTERN,
    "Identifier must be 2-12 uppercase letters or digits",
  );

/**
 * Parse a candidate project identifier.
 *
 * @param raw - Candidate identifier.
 * @returns `{ ok: true, value }` on success, `{ ok: false, error }` on failure.
 */
export function parseIdentifier(raw: string): ParseResult<Identifier> {
  if (raw.length < 2 || raw.length > 12) {
    return { ok: false, error: "Identifier must be 2-12 characters" };
  }
  if (!/^[A-Z0-9]+$/.test(raw)) {
    return {
      ok: false,
      error: "Identifier must be uppercase alphanumeric only",
    };
  }
  return { ok: true, value: raw as Identifier };
}

/**
 * Derive a short uppercase prefix from a project title.
 *
 * Multi-word titles yield initials (e.g. "Piyaz Platform" → "MP").
 * Single-word titles yield the full cleaned word (e.g. "Piyaz" → "PIYAZ").
 * Non-alphanumerics are stripped before derivation, so unicode-only titles
 * (e.g. "日本語") and single-char inputs (e.g. "A") fall through to the
 * "PROJECT" fallback since they cannot satisfy the 2-12 char rule.
 * Results are capped at 12 characters, so "Photosynthesis" → "PHOTOSYNTHES".
 * Empty or whitespace-only titles also fall back to "PROJECT".
 *
 * @param title - Project title.
 * @returns Branded identifier.
 */
export function deriveIdentifier(title: string): Identifier {
  const cleaned = title.replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const candidate =
    words.length >= 2
      ? words
          .map((w) => w[0])
          .join("")
          .toUpperCase()
          .slice(0, 12)
      : (words[0]?.toUpperCase().slice(0, 12) ?? "");
  const parsed = parseIdentifier(candidate);
  return parsed.ok ? parsed.value : ("PROJECT" as Identifier);
}

/**
 * Brand a trusted identifier string (e.g. loaded from the database or after
 * `parseIdentifier` succeeded elsewhere). Use only when the string is known
 * to satisfy {@link IDENTIFIER_PATTERN}.
 *
 * @param raw - Trusted identifier string.
 * @returns Branded identifier.
 */
export function asIdentifier(raw: string): Identifier {
  return raw as Identifier;
}

/**
 * Compose a human-readable task reference from its parts.
 *
 * @param identifier - Branded project prefix.
 * @param sequenceNumber - Per-project sequence number.
 * @returns Branded composed taskRef (e.g. "MYM-123").
 */
export function composeTaskRef(
  identifier: Identifier,
  sequenceNumber: number,
): TaskRef {
  return `${identifier}-${sequenceNumber}` as TaskRef;
}

/** A task enriched with its composed taskRef. */
export type TaskWithRef<T = { sequenceNumber: number }> = T & {
  taskRef: TaskRef;
};

/**
 * Attach a composed taskRef to each task in a list sharing one project identifier.
 *
 * @param tasks - Tasks carrying a `sequenceNumber`.
 * @param identifier - Branded project identifier.
 * @returns New array with `taskRef` added to each task.
 */
export function enrichWithTaskRef<T extends { sequenceNumber: number }>(
  tasks: readonly T[],
  identifier: Identifier,
): TaskWithRef<T>[] {
  return tasks.map((task) => ({
    ...task,
    taskRef: composeTaskRef(identifier, task.sequenceNumber),
  }));
}
