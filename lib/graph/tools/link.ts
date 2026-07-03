/**
 * `piyaz_link` handler: edge create/update/remove with ref-addressed
 * endpoints. The edge-note quality bar (substantive, no placeholders) is
 * enforced here so the doc contract matches the runtime.
 */

import {
  createEdge,
  updateEdge,
  removeEdge,
  findEdgeByNodes,
} from "@/lib/data/edge";
import type { EdgeType } from "@/lib/types";
import { resolveTaskRef, resolveTaskRefs } from "@/lib/data/resolve-ref";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  EDGE_NOTE_PLACEHOLDERS,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_link. */
export type LinkParams = {
  action: "create" | "update" | "remove";
  source?: string;
  target?: string;
  type?: "depends_on" | "relates_to";
  note?: string;
  edgeId?: string;
};

/**
 * Resolve the source and target params (refs or UUIDs) in one batched
 * lookup, failing with the per-ref corrective error when either misses.
 *
 * @param ctx - Resolved auth context.
 * @param source - Source taskRef or UUID.
 * @param target - Target taskRef or UUID.
 * @returns Both endpoint UUIDs.
 * @throws RefNotFoundError / RefAmbiguityError / MalformedRefError per ref.
 */
async function resolveEndpoints(
  ctx: AuthContext,
  source: string,
  target: string,
): Promise<{ sourceId: string; targetId: string }> {
  const resolved = await resolveTaskRefs(ctx, [source, target]);
  const sourceId = resolved.get(source)?.taskId;
  const targetId = resolved.get(target)?.taskId;
  if (!sourceId) return retryForRichError(ctx, source);
  if (!targetId) return retryForRichError(ctx, target);
  return { sourceId, targetId };
}

/**
 * Re-resolve a single missed ref so the caller gets the rich per-ref error
 * (ambiguity candidates or near-miss copy) that the batch variant omits.
 *
 * @param ctx - Resolved auth context.
 * @param ref - The ref the batch could not resolve.
 * @returns Never resolves normally.
 * @throws RefNotFoundError / RefAmbiguityError with the corrective payload.
 */
async function retryForRichError(
  ctx: AuthContext,
  ref: string,
): Promise<never> {
  await resolveTaskRef(ctx, ref);
  throw new Error(
    `ref '${ref}' resolved inconsistently between batch and single lookup`,
  );
}

/**
 * Handle piyaz_link actions.
 * @param p - Validated link params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with edge data.
 */
export async function handleLink(
  p: LinkParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "create": {
        if (!p.source || !p.target)
          return fail(
            "source and target required for create: taskRefs ('PYZ-42') or UUIDs.",
          );
        if (!p.type)
          return fail(
            "type required for create. depends_on=source needs target's output (target must be done first); relates_to=informational link, neither blocks. Litmus: removing the target makes source impossible → depends_on; just makes it harder → relates_to. Artifacts §3.",
          );
        if (!p.note || !p.note.trim())
          return fail(
            "note required for create. Edge notes propagate to downstream agent context; placeholders ('needed', 'depends', 'related') are forbidden (artifacts §3). Write it as a brief to the developer about to start the source task: what specifically does this task get from the target?",
          );
        if (EDGE_NOTE_PLACEHOLDERS.has(p.note.trim().toLowerCase()))
          return fail(
            "Placeholder edge notes ('needed', 'depends', 'related') are not substantive enough to propagate to downstream agent context (artifacts §3). Write a one-sentence brief naming what this task gets from the target: a decision, a piece of code, a contract, a fixture.",
          );
        const { sourceId, targetId } = await resolveEndpoints(
          ctx,
          p.source,
          p.target,
        );
        const edge = await createEdge(ctx, {
          sourceTaskId: sourceId,
          targetTaskId: targetId,
          edgeType: p.type as EdgeType,
          note: p.note,
        });
        return ok(edge);
      }
      case "update": {
        if (p.type === undefined && p.note === undefined)
          return fail(
            "update requires at least one of: type, note. To remove the edge, use action='remove'.",
          );
        const edgeId = await resolveEdgeKey(ctx, p);
        if (typeof edgeId !== "string") return edgeId;
        return ok(
          await updateEdge(ctx, edgeId, {
            edgeType: p.type as EdgeType | undefined,
            note: p.note,
          }),
        );
      }
      case "remove": {
        const edgeId = await resolveEdgeKey(ctx, p);
        if (typeof edgeId !== "string") return edgeId;
        await removeEdge(ctx, edgeId);
        return ok({ removed: edgeId });
      }
    }
  } catch (e) {
    return translateError(e);
  }
}

/**
 * Resolve the edge key for update/remove: an explicit edgeId, or the
 * source+target+type triple looked up via `findEdgeByNodes`.
 *
 * @param ctx - Resolved auth context.
 * @param p - Link params.
 * @returns The edge UUID, or a failure ToolResult naming the fix.
 */
async function resolveEdgeKey(
  ctx: AuthContext,
  p: LinkParams,
): Promise<string | ToolResult> {
  if (p.edgeId) return p.edgeId;
  if (p.source && p.target && p.type) {
    const { sourceId, targetId } = await resolveEndpoints(
      ctx,
      p.source,
      p.target,
    );
    const edge = await findEdgeByNodes(
      ctx,
      sourceId,
      targetId,
      p.type as EdgeType,
    );
    if (!edge) {
      return fail(
        `No ${p.type} edge from '${p.source}' to '${p.target}'. Run piyaz_map view='neighbors' task='${p.source}' to see current edges.`,
      );
    }
    return edge.id;
  }
  return fail(
    "Provide source+target+type, or an edgeId. Run piyaz_map view='neighbors' to see a task's edges.",
  );
}
