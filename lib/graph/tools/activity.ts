/**
 * `piyaz_activity` handler: keyset-paginated "what changed" per project or
 * task, with a `since` lower bound for resume-after-compaction.
 */

import { listProjectActivity, listTaskActivity } from "@/lib/data/activity";
import { formatActivityPage } from "@/lib/graph/format-responses";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  requireProjectId,
  requireTaskId,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_activity. */
export type ActivityParams = {
  project?: string;
  task?: string;
  since?: string;
  limit?: number;
  cursor?: string;
};

/**
 * Handle piyaz_activity.
 * @param p - Validated activity params (exactly one of project/task).
 * @param ctx - Resolved auth context.
 * @returns Tool result with the formatted event page.
 */
export async function handleActivity(
  p: ActivityParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    if (Boolean(p.project) === Boolean(p.task)) {
      return fail(
        "Pass exactly one of project ('PYZ' or UUID) or task ('PYZ-42' or UUID).",
      );
    }
    if (p.since !== undefined && Number.isNaN(new Date(p.since).getTime())) {
      return fail(
        `since '${p.since}' is not a valid timestamp. Pass an ISO instant like 2026-07-03T10:00:00Z (the last moment you were caught up).`,
      );
    }
    const opts = { cursor: p.cursor, limit: p.limit, since: p.since };
    const page = p.project
      ? await listProjectActivity(
          ctx,
          await requireProjectId(ctx, p.project),
          opts,
        )
      : await listTaskActivity(
          ctx,
          await requireTaskId(ctx, p.task as string),
          opts,
        );
    return ok(formatActivityPage(page.events, page.nextCursor));
  } catch (e) {
    return translateError(e);
  }
}
