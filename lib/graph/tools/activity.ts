/**
 * `piyaz_activity` handler: keyset-paginated "what changed" per project,
 * task, or note, with a `since` lower bound for resume-after-compaction.
 */

import {
  listNoteActivity,
  listProjectActivity,
  listTaskActivity,
} from "@/lib/data/activity";
import { formatActivityPage } from "@/lib/graph/format-responses";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  requireNoteId,
  requireProjectId,
  requireTaskId,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_activity. */
export type ActivityParams = {
  project?: string;
  task?: string;
  note?: string;
  since?: string;
  limit?: number;
  cursor?: string;
};

/**
 * Handle piyaz_activity. Exactly one scope of project/task/note, except
 * that project may accompany a slug-form note (it scopes the slug lookup,
 * mirroring piyaz_note). The note scope's agent-exposure gate lives in the
 * data ring (`listNoteActivity`); a non-exposed note surfaces as the same
 * not-found shape a missing note does.
 *
 * @param p - Validated activity params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with the formatted event page.
 */
export async function handleActivity(
  p: ActivityParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    const scopeCount = [p.project, p.task, p.note].filter(Boolean).length;
    const noteWithProject = Boolean(p.note) && Boolean(p.project) && !p.task;
    if (scopeCount === 0 || (scopeCount > 1 && !noteWithProject)) {
      return fail(
        "Pass exactly one scope: project ('GSP' or UUID), task ('GSP-42' or UUID), or note ('GSP-N12', UUID, or slug; slug form also needs project).",
      );
    }
    if (p.since !== undefined && Number.isNaN(new Date(p.since).getTime())) {
      return fail(
        `since '${p.since}' is not a valid timestamp. Pass an ISO instant like 2026-07-03T10:00:00Z (the last moment you were caught up).`,
      );
    }
    const opts = { cursor: p.cursor, limit: p.limit, since: p.since };
    let page: Awaited<ReturnType<typeof listProjectActivity>>;
    if (p.note) {
      const projectId = p.project
        ? await requireProjectId(ctx, p.project)
        : undefined;
      page = await listNoteActivity(
        ctx,
        await requireNoteId(ctx, p.note, projectId),
        opts,
      );
    } else if (p.project) {
      page = await listProjectActivity(
        ctx,
        await requireProjectId(ctx, p.project),
        opts,
      );
    } else {
      page = await listTaskActivity(
        ctx,
        await requireTaskId(ctx, p.task as string),
        opts,
      );
    }
    return ok(formatActivityPage(page.events, page.nextCursor));
  } catch (e) {
    return translateError(e);
  }
}
