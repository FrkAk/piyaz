import { describe, expect, test } from "bun:test";
import { noteFailureFrom } from "@/lib/actions/note-errors";
import { RateLimitError } from "@/lib/actions/rate-limit-action";
import { ForbiddenError } from "@/lib/auth/authorization";
import {
  FolderCycleError,
  NoteShareStateError,
  NoteStaleWriteError,
  NoteValidationError,
} from "@/lib/data/note";
import { ProjectArchivedError } from "@/lib/graph/errors";

/**
 * Pure unit tests for `noteFailureFrom`. No DB. Pins the typed-error →
 * `NoteActionFailure` mapping so the optimistic-concurrency payload
 * (`currentUpdatedAt` retry token, `currentVersion` banner value) survives
 * the server-action boundary and `ForbiddenError` stays anti-enumeration.
 */

describe("noteFailureFrom", () => {
  test("NoteStaleWriteError → stale_write with ISO retry token and version", () => {
    const live = new Date("2026-07-01T10:30:00.123Z");
    const out = noteFailureFrom(new NoteStaleWriteError(live, 7));
    expect(out.code).toBe("stale_write");
    if (out.code !== "stale_write") throw new Error("unreachable");
    expect(out.currentUpdatedAt).toBe("2026-07-01T10:30:00.123Z");
    expect(new Date(out.currentUpdatedAt).getTime()).toBe(live.getTime());
    expect(out.currentVersion).toBe(7);
  });

  test("NoteValidationError → invalid_input carrying the field", () => {
    const out = noteFailureFrom(
      new NoteValidationError("title", "title exceeds 2000 bytes"),
    );
    expect(out.code).toBe("invalid_input");
    if (out.code !== "invalid_input") throw new Error("unreachable");
    expect(out.field).toBe("title");
    expect(out.message).toBe("title exceeds 2000 bytes");
  });

  test("FolderCycleError → invalid_folder_move", () => {
    const out = noteFailureFrom(new FolderCycleError("a", "a/b"));
    expect(out.code).toBe("invalid_folder_move");
    expect(out.message).toContain("a");
  });

  test("NoteShareStateError → share_state, message distinguishes the reason", () => {
    const noPending = noteFailureFrom(
      new NoteShareStateError("no_pending_request"),
    );
    expect(noPending.code).toBe("share_state");
    expect(noPending.message).toBe("Note has no pending share request");

    const alreadyTeam = noteFailureFrom(
      new NoteShareStateError("already_team"),
    );
    expect(alreadyTeam.code).toBe("share_state");
    expect(alreadyTeam.message).toBe("Note is already visible to the team");
  });

  test("ForbiddenError → not_found (anti-enumeration)", () => {
    const out = noteFailureFrom(new ForbiddenError("Forbidden", "note", "x"));
    expect(out.code).toBe("not_found");
    expect(out.message).toBe("Note not found.");
  });

  test("ProjectArchivedError → archived", () => {
    expect(noteFailureFrom(new ProjectArchivedError("ZZZ")).code).toBe(
      "archived",
    );
  });

  test("RateLimitError → rate_limited", () => {
    expect(noteFailureFrom(new RateLimitError(30)).code).toBe("rate_limited");
  });

  test("bare Unauthorized error → unauthorized", () => {
    expect(noteFailureFrom(new Error("Unauthorized")).code).toBe(
      "unauthorized",
    );
  });

  test("anything else → unknown with generic copy", () => {
    const out = noteFailureFrom(new Error("pg: connection refused"));
    expect(out.code).toBe("unknown");
    expect(out.message).not.toContain("pg");
    expect(noteFailureFrom("boom").code).toBe("unknown");
    expect(noteFailureFrom(undefined).code).toBe("unknown");
  });
});
