/**
 * `piyaz_edit` handler: ordered, atomic operation lists against one task.
 * The executor (`applyTaskEdit`) owns validation and application; this
 * layer resolves the ref, derives the status-lifecycle and tag-quality
 * hints from the ops and the persisted result, and slims the response to
 * what the agent needs to chain the next call.
 */

import { applyTaskEdit, type EditOp } from "@/lib/data/task-edit";
import { getProjectTags } from "@/lib/data/project";
import { LIMITS } from "@/lib/mcp/schemas";
import type { Decision } from "@/lib/types";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  cancelledStatusHints,
  doneStatusHints,
  draftFieldHints,
  inReviewStatusHints,
  projectPhaseHints,
  requireTaskId,
  statusJumpHints,
  tagTaxonomyHints,
  tagVariantHints,
  terminalReversalHints,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_edit. */
export type EditParams = {
  task: string;
  ifUpdatedAt?: string;
  operations: EditOp[];
};

/** Per-field ceilings for edit-op text, mirroring the create-path caps. */
const TEXT_FIELD_CAPS: Record<string, number> = {
  description: LIMITS.description,
  implementationPlan: LIMITS.plan,
  executionRecord: LIMITS.executionRecord,
};

/** Per-collection item-text ceilings, mirroring the create-path caps. */
const COLLECTION_TEXT_CAPS: Record<string, number> = {
  acceptanceCriteria: LIMITS.criterionText,
  decisions: LIMITS.decision,
};

/**
 * Enforce the create-path per-field size caps on edit ops. The flat op
 * schema caps `text`/`value` only at the loosest field's ceiling, so the
 * field-specific ceilings are checked here before the executor runs.
 *
 * @param ops - The call's operations.
 * @returns A corrective error message, or null when every op fits.
 */
function oversizeOpError(ops: EditOp[]): string | null {
  for (const [i, op] of ops.entries()) {
    const fieldCap = op.field ? TEXT_FIELD_CAPS[op.field] : undefined;
    if (fieldCap !== undefined) {
      for (const s of [
        op.text,
        op.newStr,
        typeof op.value === "string" ? op.value : undefined,
      ]) {
        if (typeof s === "string" && s.length > fieldCap)
          return `operations[${i}]: ${op.field} text exceeds ${fieldCap} characters`;
      }
    }
    if (
      op.field === "title" &&
      typeof op.value === "string" &&
      op.value.length > LIMITS.title
    )
      return `operations[${i}]: title exceeds ${LIMITS.title} characters`;
    if (op.field === "tags" && Array.isArray(op.value)) {
      if (op.value.length > LIMITS.tags)
        return `operations[${i}]: tags exceeds ${LIMITS.tags} items`;
      if (op.value.some((t) => typeof t === "string" && t.length > LIMITS.tag))
        return `operations[${i}]: a tag exceeds ${LIMITS.tag} characters`;
    }
    const collectionCap = op.collection
      ? COLLECTION_TEXT_CAPS[op.collection]
      : undefined;
    if (
      collectionCap !== undefined &&
      typeof op.text === "string" &&
      op.text.length > collectionCap
    )
      return `operations[${i}]: ${op.collection} text exceeds ${collectionCap} characters`;
  }
  return null;
}

/** Fields this call's ops touched, for the completion-protocol hints. */
type OpsPayload = {
  status?: string;
  executionRecord?: string;
  implementationPlan?: string;
  decisions?: Decision[];
  files?: string[];
  tags?: string[];
  prUrl?: string | null;
  hasRemove: boolean;
};

/**
 * Derive the hint-relevant payload from the op list: which lifecycle-
 * sensitive fields this call wrote and whether any destructive remove ran.
 *
 * @param ops - The call's operations.
 * @returns The derived payload summary.
 */
function summarizeOps(ops: EditOp[]): OpsPayload {
  const payload: OpsPayload = { hasRemove: false };
  for (const op of ops) {
    if (op.op === "remove") payload.hasRemove = true;
    if (op.op === "add" && op.collection === "decisions") {
      payload.decisions = payload.decisions ?? [];
    }
    const isTextWrite =
      op.op === "set" || op.op === "append" || op.op === "str_replace";
    if (!isTextWrite || !op.field) continue;
    switch (op.field) {
      case "status":
        payload.status = op.value as string;
        break;
      case "executionRecord":
        payload.executionRecord = (op.text ?? op.newStr ?? "") || "written";
        break;
      case "implementationPlan":
        payload.implementationPlan = (op.text ?? op.newStr ?? "") || "written";
        break;
      case "files":
        payload.files = op.value as string[];
        break;
      case "tags":
        payload.tags = op.value as string[];
        break;
      case "prUrl":
        payload.prUrl = op.value as string | null;
        break;
    }
  }
  return payload;
}

/**
 * Build the status-lifecycle hints for this edit, mirroring the completion
 * protocol: planned/in_progress steering, done/in_review/cancelled
 * required-field checks against the persisted row, jump and terminal-
 * reversal warnings against the pre-edit status.
 *
 * @param payload - Fields this call's ops wrote.
 * @param priorStatus - Status before this edit, from the locked pre-edit row.
 * @param persisted - Persisted row state after the edit, including links.
 * @returns Hint strings.
 */
function statusHints(
  payload: OpsPayload,
  priorStatus: string | undefined,
  persisted: {
    executionRecord?: string | null;
    decisions?: Decision[] | null;
    files?: string[] | null;
    acceptanceCriteria?: { checked: boolean }[] | null;
    links: { kind: string }[];
  },
): string[] {
  const hints: string[] = [];
  const next = payload.status;
  if (!next) return hints;

  if (next === "planned") {
    hints.push(
      "Planned. Task surfaces in piyaz_map view='ready' once its depends_on chain reaches done. To claim: set status='in_progress'.",
    );
  }
  if (next === "in_progress") {
    hints.push(
      "Claimed (one worker per task; lifecycle §1). Run piyaz_get lens='agent' for multi-hop deps and upstream executionRecords before starting.",
    );
  }
  if (next === "done") {
    hints.push(
      ...doneStatusHints(
        {
          executionRecord: payload.executionRecord,
          decisions: payload.decisions,
          files: payload.files,
        },
        persisted,
      ),
    );
  }
  if (next === "in_review") {
    hints.push(
      ...inReviewStatusHints(
        {
          executionRecord: payload.executionRecord,
          decisions: payload.decisions,
          files: payload.files,
          prUrl: payload.prUrl,
        },
        persisted,
      ),
    );
  }
  if (next === "cancelled") {
    hints.push(
      ...cancelledStatusHints(
        {
          executionRecord: payload.executionRecord,
          decisions: payload.decisions,
        },
        persisted,
      ),
    );
  }
  if (priorStatus !== undefined && priorStatus !== next) {
    hints.push(...terminalReversalHints(priorStatus, next));
    hints.push(...statusJumpHints(priorStatus, next));
  }
  return hints;
}

/**
 * Handle piyaz_edit.
 * @param p - Validated edit params.
 * @param ctx - Resolved auth context.
 * @returns Tool result: applied op labels plus the fresh updatedAt (chain it
 *   into the next ifUpdatedAt), or the delete preview/execution payload.
 */
export async function handleEdit(
  p: EditParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    const oversize = oversizeOpError(p.operations);
    if (oversize)
      return fail(`${oversize}. The per-field limits match piyaz_create.`);
    const taskId = await requireTaskId(ctx, p.task);
    const payload = summarizeOps(p.operations);

    const result = await applyTaskEdit(
      ctx,
      taskId,
      p.operations,
      p.ifUpdatedAt,
    );

    if ("deleted" in result) {
      return ok(result);
    }
    if (!("updatedAt" in result)) {
      return ok({
        ...result,
        _hints: [
          "Preview only. For abandoned scope, prefer piyaz_edit op='set' field='status' value='cancelled' (preserves rationale + transitive dep semantics). To actually delete (only when the task is noise: accidental, duplicate, never had content), re-run with preview=false.",
        ],
      });
    }

    const hints: string[] = [];
    if (payload.hasRemove) {
      hints.push(
        "Removed items are unrecoverable; the activity log records the removal, not the content.",
      );
    }
    hints.push(
      ...draftFieldHints(payload.status, {
        executionRecord: payload.executionRecord,
        implementationPlan: payload.implementationPlan,
      }),
    );
    if (payload.tags && payload.tags.length > 0) {
      const written = new Set(payload.tags);
      // The vocabulary is read after the write, so it contains this call's
      // tags; without excluding them every proposed tag exact-matches itself
      // and findVariant never fires.
      const projectTags = (await getProjectTags(ctx, result.projectId))
        .map((t) => t.tag)
        .filter((t) => !written.has(t));
      hints.push(
        ...tagVariantHints(payload.tags, projectTags),
        ...tagTaxonomyHints(payload.tags),
      );
    }
    hints.push(
      ...statusHints(payload, result.previousStatus, {
        executionRecord: result.executionRecord,
        decisions: result.decisions,
        files: result.files as string[] | null,
        acceptanceCriteria: result.acceptanceCriteria,
        links: result.links ?? [],
      }),
    );
    hints.push(
      ...projectPhaseHints(
        result.projectStatus,
        result.projectIdentifier,
        payload.status ? [payload.status] : [],
      ),
    );

    return ok({
      id: result.id,
      applied: result.applied,
      status: result.status,
      updatedAt: new Date(result.updatedAt).toISOString(),
      ...(hints.length > 0 && { _hints: hints }),
    });
  } catch (e) {
    return translateError(e);
  }
}
