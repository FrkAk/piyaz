import "server-only";

import { taskEdges } from "@/lib/db/schema";
import type { TaskGraphEdge, TaskEdgeRef } from "@/lib/data/views";

/** Column projection for the slim {@link TaskGraphEdge} edge shape. */
export const slimEdgeColumns = {
  id: taskEdges.id,
  sourceTaskId: taskEdges.sourceTaskId,
  targetTaskId: taskEdges.targetTaskId,
  edgeType: taskEdges.edgeType,
} satisfies Record<keyof TaskGraphEdge, unknown>;

/** Column projection for {@link TaskEdgeRef} — {@link slimEdgeColumns} plus `note`. */
export const edgeRefColumns = {
  ...slimEdgeColumns,
  note: taskEdges.note,
} satisfies Record<keyof TaskEdgeRef, unknown>;
