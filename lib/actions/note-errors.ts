import "server-only";

import { RateLimitError } from "@/lib/actions/rate-limit-action";
import { ForbiddenError } from "@/lib/auth/authorization";
import {
  FolderCycleError,
  NoteShareStateError,
  NoteStaleWriteError,
  NoteValidationError,
  type NoteValidationField,
} from "@/lib/data/note";
import { ProjectArchivedError } from "@/lib/graph/errors";

export type { NoteValidationField };

/**
 * Failure half of a note action result. `stale_write` carries the note's
 * live optimistic-concurrency payload: `currentUpdatedAt` is the retry
 * token to send as the next `ifUpdatedAt`, `currentVersion` renders in the
 * conflict banner. `invalid_input` carries the offending field.
 * `rate_limited` carries the server's `retryAfter` seconds so retrying
 * callers wait out the budget window. Plain fields (not error subclasses)
 * because Next.js redacts thrown error properties across the server-action
 * boundary in production.
 */
export type NoteActionFailure =
  | {
      ok: false;
      code:
        | "unauthorized"
        | "not_found"
        | "invalid_folder_move"
        | "share_state"
        | "archived"
        | "unknown";
      message: string;
    }
  | {
      ok: false;
      code: "invalid_input";
      field: NoteValidationField;
      message: string;
    }
  | {
      ok: false;
      code: "rate_limited";
      message: string;
      retryAfter: number;
    }
  | {
      ok: false;
      code: "stale_write";
      message: string;
      currentUpdatedAt: string;
      currentVersion: number;
    };

/** Discriminated result returned by every note server action. */
export type NoteActionResult<T> = { ok: true; data: T } | NoteActionFailure;

const UNAUTHORIZED_MESSAGE = "You must be signed in to perform this action.";
const NOT_FOUND_MESSAGE = "Note not found.";
const ARCHIVED_MESSAGE = "This project is archived. Reopen it to edit notes.";
const RATE_LIMITED_MESSAGE =
  "Too many requests. Please slow down and try again shortly.";
const UNKNOWN_MESSAGE = "Something went wrong. Please try again.";

/**
 * Map a caught error from the note write path to a typed
 * {@link NoteActionFailure}. The data layer's typed errors ARE the
 * validation; this mapper only translates them into serializable results.
 * `ForbiddenError` collapses to `not_found` (anti-enumeration).
 *
 * @param err - Caught error from `authorizeWrite` or a `lib/data/note` call.
 * @returns Typed failure; `unknown` for anything unrecognized (caller logs).
 */
export function noteFailureFrom(err: unknown): NoteActionFailure {
  if (err instanceof NoteStaleWriteError) {
    return {
      ok: false,
      code: "stale_write",
      message: "This note changed since you loaded it.",
      currentUpdatedAt: err.currentUpdatedAt.toISOString(),
      currentVersion: err.currentVersion,
    };
  }
  if (err instanceof NoteValidationError) {
    return {
      ok: false,
      code: "invalid_input",
      field: err.field,
      message: err.message,
    };
  }
  if (err instanceof FolderCycleError) {
    return { ok: false, code: "invalid_folder_move", message: err.message };
  }
  if (err instanceof NoteShareStateError) {
    return { ok: false, code: "share_state", message: err.message };
  }
  if (err instanceof ForbiddenError) {
    return { ok: false, code: "not_found", message: NOT_FOUND_MESSAGE };
  }
  if (err instanceof ProjectArchivedError) {
    return { ok: false, code: "archived", message: ARCHIVED_MESSAGE };
  }
  if (err instanceof RateLimitError) {
    return {
      ok: false,
      code: "rate_limited",
      message: RATE_LIMITED_MESSAGE,
      retryAfter: err.retryAfter,
    };
  }
  if (err instanceof Error && err.message === "Unauthorized") {
    return { ok: false, code: "unauthorized", message: UNAUTHORIZED_MESSAGE };
  }
  return { ok: false, code: "unknown", message: UNKNOWN_MESSAGE };
}
