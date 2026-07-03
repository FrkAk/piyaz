/**
 * `piyaz_create` handler: idempotent batch task creation with internal
 * edges. Ref-shaped edge endpoints are pre-resolved here (the batch layer
 * accepts only item keys and UUIDs); title-deduped items come back as
 * `deduped` so restarted decompose runs never duplicate a task set.
 */

import {
  createTasksBatch,
  type BatchEdgeInput,
  type BatchTaskInput,
} from "@/lib/data/task-batch";
import { getProjectTags } from "@/lib/data/project";
import { TASK_REF_PATTERN } from "@/lib/data/task";
import { resolveTaskRef, resolveTaskRefs } from "@/lib/data/resolve-ref";
import { isUuid } from "@/lib/auth/authorization";
import type { Decision, Priority, Estimate } from "@/lib/types";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  acQualityHints,
  descriptionSizeHints,
  draftFieldHints,
  edgeNoteViolation,
  requireProjectId,
  tagTaxonomyHints,
  tagVariantHints,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** One task item as validated by the schema. */
export type CreateTaskItem = {
  key?: string;
  title: string;
  description: string;
  status?:
    | "draft"
    | "planned"
    | "in_progress"
    | "in_review"
    | "done"
    | "cancelled";
  acceptanceCriteria?: string[];
  decisions?: string[];
  tags?: string[];
  category?: string;
  priority?: Priority;
  estimate?: Estimate;
  assigneeIds?: string[];
  files?: string[];
  implementationPlan?: string;
  executionRecord?: string;
  prUrl?: string;
};

/** One edge item as validated by the schema. */
export type CreateEdgeItem = {
  source: string;
  target: string;
  type: "depends_on" | "relates_to";
  note: string;
};

/** Params for piyaz_create. */
export type CreateParams = {
  project: string;
  tasks: CreateTaskItem[];
  edges?: CreateEdgeItem[];
  onDuplicate?: "skip" | "error";
};

/** Cap on per-item quality hints so a large batch cannot flood the reply. */
const MAX_ITEM_HINTS = 12;

/**
 * Pre-resolve ref-shaped edge endpoints to UUIDs in one batched lookup.
 * Item keys and UUIDs pass through; a ref the batch cannot resolve is
 * re-resolved singly so the caller gets the rich per-ref error.
 *
 * @param ctx - Resolved auth context.
 * @param edges - Schema-validated edges.
 * @param keys - Declared item keys.
 * @returns Edges with every non-key endpoint expressed as a UUID.
 */
async function resolveEdgeRefs(
  ctx: AuthContext,
  edges: CreateEdgeItem[],
  keys: Set<string>,
): Promise<BatchEdgeInput[]> {
  const refs = new Set<string>();
  for (const e of edges) {
    for (const endpoint of [e.source, e.target]) {
      if (keys.has(endpoint) || isUuid(endpoint)) continue;
      if (TASK_REF_PATTERN.test(endpoint)) refs.add(endpoint);
    }
  }
  if (refs.size === 0) return edges;
  const resolved = await resolveTaskRefs(ctx, [...refs]);
  for (const ref of refs) {
    if (!resolved.has(ref)) await resolveTaskRef(ctx, ref);
  }
  const toId = (endpoint: string): string =>
    resolved.get(endpoint)?.taskId ?? endpoint;
  return edges.map((e) => ({
    ...e,
    source: toId(e.source),
    target: toId(e.target),
  }));
}

/**
 * Build per-item artifact-quality hints (description size, AC band, tag
 * taxonomy and variants, draft-forbidden fields), each prefixed with the
 * item's key or title and capped at {@link MAX_ITEM_HINTS}.
 *
 * @param items - Schema-validated task items.
 * @param projectTags - Existing project tag vocabulary.
 * @returns Hint strings.
 */
function itemQualityHints(
  items: CreateTaskItem[],
  projectTags: string[],
): string[] {
  const hints: string[] = [];
  for (const item of items) {
    const label = item.key ?? `"${item.title}"`;
    const itemHints = [
      ...descriptionSizeHints(item.description),
      ...acQualityHints(item.acceptanceCriteria),
      ...(item.tags && item.tags.length > 0
        ? [
            ...tagVariantHints(item.tags, projectTags),
            ...tagTaxonomyHints(item.tags),
          ]
        : []),
      ...draftFieldHints(item.status ?? "draft", {
        executionRecord: item.executionRecord,
        implementationPlan: item.implementationPlan,
      }),
    ];
    for (const h of itemHints) hints.push(`${label}: ${h}`);
    if (hints.length >= MAX_ITEM_HINTS) {
      hints.length = MAX_ITEM_HINTS;
      hints.push(
        "Further per-item hints suppressed. Review every task against artifacts §1-2.",
      );
      break;
    }
  }
  return hints;
}

/**
 * Handle piyaz_create.
 * @param p - Validated create params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with created/deduped refs and hints.
 */
export async function handleCreate(
  p: CreateParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    const projectId = await requireProjectId(ctx, p.project);
    const keys = new Set(
      p.tasks.map((t) => t.key).filter((k): k is string => k !== undefined),
    );
    const conflictingKey = [...keys].find(
      (k) => !isUuid(k) && TASK_REF_PATTERN.test(k),
    );
    if (conflictingKey) {
      return fail(
        `Item key '${conflictingKey}' is taskRef-shaped and would be ambiguous as an edge endpoint. Use a plain word key (e.g. 'auth').`,
      );
    }
    for (const [i, e] of (p.edges ?? []).entries()) {
      const violation = edgeNoteViolation(e.note);
      if (violation) return fail(`edges[${i}]: ${violation}`);
    }
    for (const [i, t] of p.tasks.entries()) {
      const badAssignee = t.assigneeIds?.find((a) => a !== "me" && !isUuid(a));
      if (badAssignee !== undefined) {
        return fail(
          `tasks[${i}]: assigneeIds entry '${badAssignee}' must be 'me' or a team-member user UUID. No writes happened.`,
        );
      }
    }
    const edges = await resolveEdgeRefs(ctx, p.edges ?? [], keys);

    const anyTags = p.tasks.some((t) => t.tags && t.tags.length > 0);
    const projectTags = anyTags
      ? (await getProjectTags(ctx, projectId)).map((t) => t.tag)
      : [];

    const items: BatchTaskInput[] = p.tasks.map((t) => ({
      key: t.key,
      title: t.title,
      description: t.description,
      status: t.status,
      acceptanceCriteria: t.acceptanceCriteria as unknown as {
        id: string;
        text: string;
        checked: boolean;
      }[],
      decisions: t.decisions as unknown as Decision[],
      tags: t.tags,
      category: t.category,
      priority: t.priority,
      estimate: t.estimate,
      assigneeIds: t.assigneeIds?.map((a) => (a === "me" ? ctx.userId : a)),
      files: t.files,
      implementationPlan: t.implementationPlan,
      executionRecord: t.executionRecord,
      prUrl: t.prUrl,
    }));

    const result = await createTasksBatch(
      ctx,
      projectId,
      items,
      edges,
      p.onDuplicate ?? "skip",
    );

    const hints: string[] = [];
    if (result.deduped.length > 0) {
      hints.push(
        `${result.deduped.length} task(s) matched existing titles and were skipped (idempotent re-run): ${result.deduped
          .map((d) => `\`${d.taskRef}\``)
          .join(", ")}. Their existing rows were reused as edge endpoints.`,
      );
    }
    hints.push(...itemQualityHints(p.tasks, projectTags));
    const missingCategory = p.tasks.filter((t) => !t.category).length;
    if (missingCategory > 0) {
      hints.push(
        `${missingCategory} task(s) have no category. Run piyaz_get project='${p.project}' view='meta' for the vocabulary, then set one per task via piyaz_edit.`,
      );
    }
    if (edges.length === 0 && result.created.length > 0) {
      hints.push(
        "No edges in this batch. Bare tasks orphan from critical_path, downstream, and agent-context propagation. Wire dependencies with piyaz_link (substantive notes); verify with piyaz_map view='neighbors'.",
      );
    }

    return ok({
      created: result.created.map((c) => ({
        taskRef: c.taskRef,
        id: c.id,
        title: c.title,
        ...(c.key !== undefined && { key: c.key }),
      })),
      deduped: result.deduped.map((d) => ({
        taskRef: d.taskRef,
        id: d.id,
        title: d.title,
        ...(d.key !== undefined && { key: d.key }),
      })),
      edges: result.edges,
      ...(hints.length > 0 && { _hints: hints }),
    });
  } catch (e) {
    return translateError(e);
  }
}
