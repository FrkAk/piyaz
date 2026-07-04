/**
 * `piyaz_get` handler: read one task (lens or raw fields) or one project
 * (meta or budgeted overview). The lens ladder and the `fields=[...]` path
 * give agents the lightest read that answers the question.
 */

import { getProjectMeta } from "@/lib/data/project";
import { getTaskFields } from "@/lib/data/task";
import type { TaskFieldName } from "@/lib/db/raw/fetch-task-full";
import { buildProjectOverview } from "@/lib/context/_core/overview";
import { buildSummaryContext } from "@/lib/context/_core/summary";
import {
  buildWorkingContext,
  formatWorkingContext,
} from "@/lib/context/_core/working";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { buildPlanningContext } from "@/lib/context/_core/planning";
import { buildReviewContext } from "@/lib/context/_core/review";
import { buildRecordContextFrom } from "@/lib/context/_core/record";
import { resolveRecordData } from "@/lib/context/_core/bundle";
import {
  formatSummary,
  formatOverview,
  formatProjectMeta,
} from "@/lib/graph/format-responses";
import { untrustedContentNotice } from "@/lib/context/format";
import { composeTaskRef, asIdentifier } from "@/lib/graph/identifier";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  requireProjectId,
  requireTaskId,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_get. */
export type GetParams = {
  task?: string;
  project?: string;
  lens?: "summary" | "working" | "agent" | "planning" | "review" | "record";
  view?: "meta" | "overview";
  fields?: TaskFieldName[];
  detail?: "concise" | "detailed";
  limit?: number;
};

/**
 * Render one field's value as markdown lines. Collections render one item
 * per line WITH the item id (the piyaz_edit by-id address); arrays render
 * inline; text fields render raw.
 *
 * @param field - Field name.
 * @param row - Field-projected raw row.
 * @returns Markdown lines for the field section.
 */
function renderField(
  field: TaskFieldName,
  row: Awaited<ReturnType<typeof getTaskFields>>,
): string[] {
  const lines: string[] = [`## ${field}`];
  switch (field) {
    case "acceptanceCriteria": {
      const items = row.acceptance_criteria ?? [];
      if (items.length === 0) lines.push("(none)");
      for (const c of items)
        lines.push(`- [${c.checked ? "x" : " "}] ${c.text} \`${c.id}\``);
      break;
    }
    case "decisions": {
      const items = row.decisions ?? [];
      if (items.length === 0) lines.push("(none)");
      for (const d of items)
        lines.push(`- [${d.source}] ${d.text} (${d.date}) \`${d.id}\``);
      break;
    }
    case "links": {
      const items = row.links ?? [];
      if (items.length === 0) lines.push("(none)");
      for (const l of items)
        lines.push(
          `- [${l.kind}] ${l.label ? `${l.label} ` : ""}${l.url} \`${l.id}\``,
        );
      break;
    }
    case "assignees": {
      const items = row.assignees ?? [];
      if (items.length === 0) lines.push("(none)");
      for (const a of items) lines.push(`- ${a.name} \`${a.userId}\``);
      break;
    }
    case "tags":
      lines.push(
        (row.tags ?? []).map((t) => `\`${t}\``).join(", ") || "(none)",
      );
      break;
    case "files":
      lines.push((row.files ?? []).join("\n") || "(none)");
      break;
    case "title":
      lines.push(row.title ?? "(none)");
      break;
    case "description":
      lines.push(row.description ?? "(none)");
      break;
    case "status":
      lines.push(row.status ?? "(none)");
      break;
    case "category":
      lines.push(row.category ?? "(none)");
      break;
    case "priority":
      lines.push(row.priority ?? "(none)");
      break;
    case "estimate":
      lines.push(row.estimate != null ? `${row.estimate}` : "(none)");
      break;
    case "implementationPlan":
      lines.push(row.implementation_plan ?? "(none)");
      break;
    case "executionRecord":
      lines.push(row.execution_record ?? "(none)");
      break;
  }
  return lines;
}

/**
 * Handle the `fields=[...]` raw read: one round trip, only the requested
 * columns egressed, `updatedAt` emitted for `ifUpdatedAt` preconditions.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - Resolved task UUID.
 * @param fields - Requested field names.
 * @returns Tool result with the per-field markdown.
 */
async function handleFieldsRead(
  ctx: AuthContext,
  taskId: string,
  fields: TaskFieldName[],
): Promise<ToolResult> {
  const row = await getTaskFields(ctx, taskId, fields);
  const ref = composeTaskRef(
    asIdentifier(row.project_identifier),
    row.sequence_number,
  );
  const updatedAt = new Date(row.updated_at as string | Date).toISOString();
  const parts: string[] = [
    untrustedContentNotice(),
    "",
    `# \`${ref}\` fields`,
    `updatedAt: ${updatedAt} (pass as ifUpdatedAt on piyaz_edit for a compare-and-swap)`,
  ];
  for (const field of fields) parts.push("", ...renderField(field, row));
  return ok(parts.join("\n"));
}

/**
 * Handle piyaz_get.
 * @param p - Validated get params (exactly one of task/project).
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
export async function handleGet(
  p: GetParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    if (Boolean(p.task) === Boolean(p.project)) {
      return fail(
        "Pass exactly one of task ('PYZ-42' or UUID) or project ('PYZ' or UUID).",
      );
    }

    if (p.task) {
      const taskId = await requireTaskId(ctx, p.task);
      if (p.fields && p.fields.length > 0) {
        return await handleFieldsRead(ctx, taskId, p.fields);
      }
      switch (p.lens ?? "working") {
        case "summary":
          return ok(formatSummary(await buildSummaryContext(ctx, taskId)));
        case "working":
          return ok(
            await formatWorkingContext(await buildWorkingContext(ctx, taskId)),
          );
        case "agent":
          return ok(await buildAgentContext(ctx, taskId));
        case "planning":
          return ok(await buildPlanningContext(ctx, taskId));
        case "review":
          return ok(await buildReviewContext(ctx, taskId));
        case "record":
          return ok(
            buildRecordContextFrom(await resolveRecordData(ctx.userId, taskId)),
          );
      }
    }

    const projectId = await requireProjectId(ctx, p.project as string);
    if ((p.view ?? "meta") === "meta") {
      return ok(formatProjectMeta(await getProjectMeta(ctx, projectId)));
    }
    const overview = await buildProjectOverview(ctx, projectId);
    if (!overview) return fail(`Project '${p.project}' not found.`);
    const rendered = formatOverview(overview, {
      limit: p.limit,
      detail: p.detail,
    });
    return ok(
      rendered.text,
      rendered.truncated ? { truncated: true } : undefined,
    );
  } catch (e) {
    return translateError(e);
  }
}
