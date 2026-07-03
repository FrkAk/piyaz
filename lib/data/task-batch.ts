import "server-only";

import { and, eq, inArray, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { withUserContext, type Tx } from "@/lib/db/rls";
import { tasks, taskEdges } from "@/lib/db/schema";
import { acquireProjectLock } from "@/lib/db/raw/acquire-project-lock";
import {
  assertProjectAccessTx,
  ForbiddenError,
} from "@/lib/auth/authorization";
import {
  insertActivityEvents,
  type ActivityEventInput,
} from "@/lib/data/activity";
import {
  createTaskTx,
  prepareCreateTaskInput,
  type CreateTaskInput,
  type CreatedTaskSummary,
} from "@/lib/data/task";
import { listDependsOnEdges } from "@/lib/data/edge";
import { asIdentifier, composeTaskRef } from "@/lib/graph/identifier";
import {
  CrossProjectEdgeError,
  DuplicateEdgeError,
  EdgeCycleError,
  SelfEdgeError,
  TaskLimitError,
} from "@/lib/graph/errors";
import { formatMarkdown } from "@/lib/markdown/format";
import { parseEnvInt } from "@/lib/config/env";
import { emitEdgeMutation, emitTaskEvent } from "@/lib/realtime/events";
import type { AuthContext } from "@/lib/auth/context";

// ---------------------------------------------------------------------------
// Public types + errors
// ---------------------------------------------------------------------------

/** One task in a batch; `key` names it for intra-batch edge endpoints. */
export type BatchTaskInput = Omit<CreateTaskInput, "projectId"> & {
  key?: string;
};

/** One edge in a batch; endpoints are item `key`s or task UUIDs in the project. */
export type BatchEdgeInput = {
  source: string;
  target: string;
  type: "depends_on" | "relates_to";
  note: string;
};

/** Per-item result: the resolved task id and composed taskRef. */
type BatchItemResult = {
  key?: string;
  id: string;
  taskRef: string;
  title: string;
};

/** Thrown when titles collide and `onDuplicate` is `error`, before any write. */
export class DuplicateTaskTitleError extends Error {
  /**
   * @param titles - Every colliding title (intra-batch and vs existing rows).
   */
  constructor(public readonly titles: string[]) {
    super(`Duplicate task title(s): ${titles.join(", ")}`);
    this.name = "DuplicateTaskTitleError";
  }
}

/** Thrown when the batch payload is structurally invalid, before any write. */
export class BatchInputError extends Error {
  /**
   * @param message - Corrective message naming the offending constraint.
   */
  constructor(message: string) {
    super(message);
    this.name = "BatchInputError";
  }
}

/** Inclusive bounds on items per batch call. */
const MIN_BATCH_ITEMS = 1;
const MAX_BATCH_ITEMS = 25;

/** Upper bound on edges per batch call. */
const MAX_BATCH_EDGES = 100;

/** Canonical UUID shape; gates raw edge endpoints before a `::uuid` cast. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Pre-transaction validation
// ---------------------------------------------------------------------------

/**
 * Validate the batch payload before any DB work: item count, edge count,
 * unique `key`s, non-empty edge notes, raw self-edges, and endpoint shape
 * (known key or UUID).
 *
 * @param items - Batch task inputs.
 * @param edges - Batch edge inputs.
 * @returns The set of declared item keys, for endpoint resolution.
 * @throws BatchInputError on any structural violation.
 * @throws SelfEdgeError when an edge names the same raw endpoint twice.
 */
function validateBatch(
  items: BatchTaskInput[],
  edges: BatchEdgeInput[],
): Set<string> {
  if (items.length < MIN_BATCH_ITEMS || items.length > MAX_BATCH_ITEMS) {
    throw new BatchInputError(
      `items must be ${MIN_BATCH_ITEMS}..${MAX_BATCH_ITEMS} (got ${items.length})`,
    );
  }
  if (edges.length > MAX_BATCH_EDGES) {
    throw new BatchInputError(
      `edges must be at most ${MAX_BATCH_EDGES} (got ${edges.length})`,
    );
  }
  const keyList = items
    .map((i) => i.key)
    .filter((k): k is string => k !== undefined);
  const keySet = new Set(keyList);
  if (keySet.size !== keyList.length) {
    throw new BatchInputError("item keys must be unique within the batch");
  }
  edges.forEach((e, idx) => {
    if (e.source === e.target) throw new SelfEdgeError();
    if (typeof e.note !== "string" || e.note.trim() === "") {
      throw new BatchInputError(`edges[${idx}] requires a non-empty note`);
    }
    for (const endpoint of [e.source, e.target]) {
      if (!keySet.has(endpoint) && !UUID_RE.test(endpoint)) {
        throw new BatchInputError(
          `edges[${idx}] endpoint '${endpoint}' is neither a known item key nor a task UUID`,
        );
      }
    }
  });
  return keySet;
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * Find a directed cycle in a `depends_on` adjacency map via iterative DFS.
 * Colors nodes white/gray/black and reconstructs the closing chain from the
 * DFS path when a back edge into a gray node is found.
 *
 * @param adj - Source id → target ids adjacency for the merged graph.
 * @returns The cycle's member ids in order, or null when the graph is acyclic.
 */
function detectCycle(adj: Map<string, string[]>): string[] | null {
  const state = new Map<string, number>();
  const nodes = new Set<string>();
  for (const [source, targets] of adj) {
    nodes.add(source);
    for (const target of targets) nodes.add(target);
  }
  for (const start of nodes) {
    if (state.get(start)) continue;
    const path: string[] = [start];
    const stack: { node: string; next: number }[] = [{ node: start, next: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.next < neighbors.length) {
        const target = neighbors[frame.next++];
        const color = state.get(target) ?? 0;
        if (color === 1) return path.slice(path.indexOf(target));
        if (color === 0) {
          state.set(target, 1);
          path.push(target);
          stack.push({ node: target, next: 0 });
        }
      } else {
        state.set(frame.node, 2);
        path.pop();
        stack.pop();
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Batch create
// ---------------------------------------------------------------------------

/**
 * Create up to 25 tasks and their edges in one RLS-scoped transaction,
 * idempotently: items whose exact title already exists in the project (or
 * repeats earlier in the batch) create nothing and are returned in `deduped`,
 * so a restarted decompose run stops duplicating task sets. Edges that already
 * exist are silently skipped; a re-run of the same payload is a clean no-op.
 *
 * `source`/`target` on edges are item `key`s or task UUIDs already in the
 * project; taskRef-shaped strings are NOT accepted here — the MCP handler
 * pre-resolves refs via `resolveTaskRefs` before calling this function.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the owning project (never a ref).
 * @param items - 1..25 task inputs; `key` names an item for edge endpoints.
 * @param edges - Edges between item keys and/or existing project task UUIDs.
 * @param onDuplicate - `skip` dedups title collisions; `error` rejects the
 *   whole batch with {@link DuplicateTaskTitleError} before any write.
 * @returns Created and deduped items in input order, plus the inserted edge count.
 * @throws BatchInputError on a structurally invalid payload.
 * @throws DuplicateTaskTitleError when `onDuplicate` is `error` and titles collide.
 * @throws TaskLimitError when the create count would exceed the project cap.
 * @throws SelfEdgeError / CrossProjectEdgeError / DuplicateEdgeError / EdgeCycleError
 *   on an invalid edge.
 * @throws ForbiddenError when a UUID endpoint is not a task the caller can access.
 */
export async function createTasksBatch(
  ctx: AuthContext,
  projectId: string,
  items: BatchTaskInput[],
  edges: BatchEdgeInput[] = [],
  onDuplicate: "skip" | "error" = "skip",
): Promise<{
  created: BatchItemResult[];
  deduped: BatchItemResult[];
  edges: number;
}> {
  const keySet = validateBatch(items, edges);

  const preparedItems = await Promise.all(
    items.map(async (item) => {
      const { key, ...rest } = item;
      const data = await prepareCreateTaskInput({
        ...rest,
        projectId,
      } as CreateTaskInput);
      return { key, data };
    }),
  );
  const formattedEdges = await Promise.all(
    edges.map(async (e) => ({
      ...e,
      note: (await formatMarkdown(e.note)) ?? e.note,
    })),
  );

  const titles = preparedItems.map((p) => p.data.title);
  const firstIndexByTitle = new Map<string, number>();
  const intraDupTitles: string[] = [];
  titles.forEach((title, i) => {
    if (firstIndexByTitle.has(title)) {
      if (!intraDupTitles.includes(title)) intraDupTitles.push(title);
    } else {
      firstIndexByTitle.set(title, i);
    }
  });

  const result = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, projectId);
    const identifier = access.project.identifier;
    await acquireProjectLock(tx, projectId);

    const [maxRow] = await tx
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${tasks.order}), -1)`,
        maxSeq: sql<number>`COALESCE(MAX(${tasks.sequenceNumber}), 0)`,
        taskCount: sql<number>`COUNT(*)`,
      })
      .from(tasks)
      .where(eq(tasks.projectId, projectId));
    const maxOrderBase = Number(maxRow?.maxOrder ?? -1);
    const maxSeqBase = Number(maxRow?.maxSeq ?? 0);
    const count = Number(maxRow?.taskCount ?? 0);

    const distinctTitles = [...firstIndexByTitle.keys()];
    const existingRows = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        sequenceNumber: tasks.sequenceNumber,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          inArray(tasks.title, distinctTitles),
        ),
      );
    const existingByTitle = new Map(existingRows.map((r) => [r.title, r]));

    if (onDuplicate === "error") {
      const colliding = [
        ...new Set([
          ...intraDupTitles,
          ...distinctTitles.filter((t) => existingByTitle.has(t)),
        ]),
      ];
      if (colliding.length > 0) throw new DuplicateTaskTitleError(colliding);
    }

    const isCreatedIndex = (i: number): boolean =>
      !existingByTitle.has(titles[i]) && firstIndexByTitle.get(titles[i]) === i;
    const toCreate = preparedItems
      .map((_, i) => i)
      .filter((i) => isCreatedIndex(i));

    const maxTasks = parseEnvInt(process.env.MAX_TASKS_PER_PROJECT, 50_000);
    if (count + toCreate.length > maxTasks) {
      throw new TaskLimitError(projectId, maxTasks);
    }

    let seq = maxSeqBase;
    let order = maxOrderBase;
    const createdByIndex = new Map<number, CreatedTaskSummary>();
    const taskEvents: ActivityEventInput[] = [];
    for (const i of toCreate) {
      seq += 1;
      order += 1;
      const { task, events } = await createTaskTx(
        tx,
        ctx.actor,
        preparedItems[i].data,
        { sequenceNumber: seq, order, identifier },
        { deferActivity: true },
      );
      createdByIndex.set(i, task);
      taskEvents.push(...events);
    }

    const resolveItem = (i: number): BatchItemResult => {
      const title = titles[i];
      const key = preparedItems[i].key;
      const existing = existingByTitle.get(title);
      if (existing) {
        return {
          key,
          id: existing.id,
          taskRef: composeTaskRef(
            asIdentifier(identifier),
            existing.sequenceNumber,
          ),
          title,
        };
      }
      const summary = createdByIndex.get(firstIndexByTitle.get(title)!)!;
      return { key, id: summary.id, taskRef: summary.taskRef, title };
    };

    const keyToId = new Map<string, string>();
    preparedItems.forEach((p, i) => {
      if (p.key !== undefined) keyToId.set(p.key, resolveItem(i).id);
    });

    const edgeResult = await applyBatchEdges(
      tx,
      projectId,
      formattedEdges,
      keySet,
      keyToId,
    );
    await insertActivityEvents(tx, ctx.actor, [
      ...taskEvents,
      ...edgeResult.events,
    ]);

    const created: BatchItemResult[] = [];
    const deduped: BatchItemResult[] = [];
    preparedItems.forEach((_, i) => {
      const entry = resolveItem(i);
      if (isCreatedIndex(i)) created.push(entry);
      else deduped.push(entry);
    });
    const lastCreated = toCreate.length
      ? createdByIndex.get(toCreate[toCreate.length - 1])!.id
      : null;

    return {
      created,
      deduped,
      edges: edgeResult.count,
      firstEdge: edgeResult.firstEdge,
      lastCreated,
    };
  });

  if (result.lastCreated) {
    emitTaskEvent(projectId, result.lastCreated);
  } else if (result.firstEdge) {
    emitEdgeMutation(
      projectId,
      result.firstEdge.sourceId,
      result.firstEdge.targetId,
    );
  }
  return {
    created: result.created,
    deduped: result.deduped,
    edges: result.edges,
  };
}

/** A batch edge with both endpoints resolved to task ids. */
type ResolvedEdge = {
  sourceId: string;
  targetId: string;
  type: "depends_on" | "relates_to";
  note: string;
};

/**
 * Resolve, validate, cycle-check, and insert the batch's edges, returning the
 * inserted count plus the `edge_added` events for the caller's single activity
 * write. Edges duplicating an existing row are silently skipped (idempotent
 * re-run); duplicates within the batch throw {@link DuplicateEdgeError}.
 *
 * @param tx - Active RLS-scoped transaction handle.
 * @param projectId - Owning project id (UUID endpoints must belong to it).
 * @param edges - Batch edges with notes already formatted.
 * @param keySet - Declared item keys (endpoints not in the set are UUIDs).
 * @param keyToId - Item key → resolved task id.
 * @returns The inserted edge count, the first inserted edge's endpoints (for
 *   the caller's post-commit realtime emit), and the `edge_added` events.
 * @throws SelfEdgeError when a resolved edge connects a task to itself.
 * @throws DuplicateEdgeError on a duplicate edge within the batch.
 * @throws CrossProjectEdgeError when a UUID endpoint is in another project.
 * @throws ForbiddenError when a UUID endpoint is not an accessible task.
 * @throws EdgeCycleError when the new `depends_on` edges close a cycle.
 */
async function applyBatchEdges(
  tx: Tx,
  projectId: string,
  edges: BatchEdgeInput[],
  keySet: Set<string>,
  keyToId: Map<string, string>,
): Promise<{
  count: number;
  firstEdge: { sourceId: string; targetId: string } | null;
  events: ActivityEventInput[];
}> {
  const uuidEndpoints = new Set<string>();
  for (const e of edges) {
    for (const endpoint of [e.source, e.target]) {
      if (!keySet.has(endpoint)) uuidEndpoints.add(endpoint);
    }
  }
  const uuidList = [...uuidEndpoints];
  const uuidRows = uuidList.length
    ? await tx
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(inArray(tasks.id, uuidList))
    : [];
  const uuidById = new Map(uuidRows.map((r) => [r.id, r]));
  for (const id of uuidList) {
    const row = uuidById.get(id);
    if (!row) throw new ForbiddenError("Forbidden", "task", id);
    if (row.projectId !== projectId) throw new CrossProjectEdgeError();
  }

  const seen = new Set<string>();
  const resolved: ResolvedEdge[] = [];
  for (const e of edges) {
    const sourceId = keySet.has(e.source) ? keyToId.get(e.source)! : e.source;
    const targetId = keySet.has(e.target) ? keyToId.get(e.target)! : e.target;
    if (sourceId === targetId) throw new SelfEdgeError();
    const dedupeKey = `${sourceId}|${targetId}|${e.type}`;
    if (seen.has(dedupeKey))
      throw new DuplicateEdgeError(sourceId, targetId, e.type);
    seen.add(dedupeKey);
    resolved.push({ sourceId, targetId, type: e.type, note: e.note });
  }
  if (resolved.length === 0) return { count: 0, firstEdge: null, events: [] };

  const existingRows = await tx
    .select({
      sourceTaskId: taskEdges.sourceTaskId,
      targetTaskId: taskEdges.targetTaskId,
      edgeType: taskEdges.edgeType,
    })
    .from(taskEdges)
    .where(
      or(
        ...resolved.map((e) =>
          and(
            eq(taskEdges.sourceTaskId, e.sourceId),
            eq(taskEdges.targetTaskId, e.targetId),
            eq(taskEdges.edgeType, e.type),
          ),
        ),
      ),
    );
  const existingSet = new Set(
    existingRows.map(
      (r) => `${r.sourceTaskId}|${r.targetTaskId}|${r.edgeType}`,
    ),
  );
  const toInsert = resolved.filter(
    (e) => !existingSet.has(`${e.sourceId}|${e.targetId}|${e.type}`),
  );

  const newDependsOn = toInsert.filter((e) => e.type === "depends_on");
  if (newDependsOn.length > 0) {
    const idRows = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.projectId, projectId));
    const existingDeps = await listDependsOnEdges(
      idRows.map((r) => r.id),
      tx,
    );
    const adj = new Map<string, string[]>();
    const link = (s: string, t: string): void => {
      const list = adj.get(s) ?? [];
      list.push(t);
      adj.set(s, list);
    };
    for (const e of existingDeps) link(e.sourceTaskId, e.targetTaskId);
    for (const e of newDependsOn) link(e.sourceId, e.targetId);
    const cycle = detectCycle(adj);
    if (cycle) throw new EdgeCycleError(cycle);
  }

  if (toInsert.length > 0) {
    await tx.insert(taskEdges).values(
      toInsert.map((e) => ({
        sourceTaskId: e.sourceId,
        targetTaskId: e.targetId,
        edgeType: e.type,
        note: e.note,
      })),
    );
  }

  const edgeEvents: ActivityEventInput[] = [];
  for (const e of toInsert) {
    edgeEvents.push(
      {
        projectId,
        taskId: e.sourceId,
        type: "edge_added",
        summary: `added ${e.type} → target`,
        targetRef: e.targetId,
        metadata: { direction: "outgoing", relation: e.type },
      },
      {
        projectId,
        taskId: e.targetId,
        type: "edge_added",
        summary: `added ${e.type} ← source`,
        targetRef: e.sourceId,
        metadata: { direction: "incoming", relation: e.type },
      },
    );
  }

  const firstEdge = toInsert.length
    ? { sourceId: toInsert[0].sourceId, targetId: toInsert[0].targetId }
    : null;
  return { count: toInsert.length, firstEdge, events: edgeEvents };
}
