/**
 * `piyaz_search` handler: the universal task finder. Cross-project by
 * default, project-scoped on demand, filterable, keyset-paginated.
 */

import { searchTasksForMcp } from "@/lib/data/task";
import { normalizeTags } from "@/lib/graph/tag-similarity";
import { formatMcpSearchPage } from "@/lib/graph/format-responses";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  requireProjectId,
  stateHint,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_search. */
export type SearchParams = {
  query?: string;
  project?: string;
  status?: string[];
  priority?: string[];
  assignee?: string;
  category?: string;
  tags?: string[];
  limit?: number;
  cursor?: string;
};

/**
 * Handle piyaz_search. At least one criterion is required; the data layer
 * throws `SearchCriteriaRequiredError` otherwise (translated to a
 * corrective message).
 * @param p - Validated search params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with the formatted page.
 */
export async function handleSearch(
  p: SearchParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    const projectId = p.project
      ? await requireProjectId(ctx, p.project)
      : undefined;
    const page = await searchTasksForMcp(ctx, {
      query: p.query,
      projectId,
      status: p.status,
      priority: p.priority,
      assignee: p.assignee,
      category: p.category,
      tags: p.tags ? normalizeTags(p.tags) : undefined,
      limit: p.limit,
      cursor: p.cursor,
    });
    const hint =
      page.items.length === 1 && page.items[0].state
        ? stateHint(page.items[0].state)
        : undefined;
    return ok(formatMcpSearchPage(page, hint));
  } catch (e) {
    return translateError(e);
  }
}
