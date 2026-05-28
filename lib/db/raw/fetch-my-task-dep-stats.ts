import { sql } from "drizzle-orm";
import { executeRaw, type Conn, uuidArray } from "@/lib/db/raw";

/**
 * Per-anchor dep stats projected from the recursive walks below.
 *
 * `blockerSequenceNumber` is the lowest `sequence_number` among non-done
 * active effective upstreams. `null` if there are no non-done upstreams.
 * `allDepsDone` mirrors that signal: true when the anchor has no non-done
 * active upstream.
 */
export type MyTaskDepStats = {
  upstreamCount: number;
  downstreamCount: number;
  allDepsDone: boolean;
  blockerSequenceNumber: number | null;
};

/**
 * Batched per-anchor effective-dependency stats for `listMyTasks`.
 *
 * For each anchor task id this returns the count of distinct active
 * effective upstream tasks, the count of distinct active effective
 * downstream tasks, and the lowest `sequence_number` among non-done
 * active effective upstreams (the {@link MyTaskDepStats.blockerSequenceNumber}
 * used to render the `Blocked by …` chip).
 *
 * Two recursive CTEs in a single statement walk forward (`depends_on`
 * followers) and backward (`depends_on` predecessors) from every anchor,
 * treating cancelled tasks as transparent: a chain
 * `A → B(cancelled) → C(active)` consumes one effective hop, not two.
 * `CYCLE` terminates on cycles (including cancelled-only loops); the
 * `project_id` join filter keeps a stale cross-project edge from leaking
 * a foreign-project task into the result.
 *
 * Replaces the previous per-project full-graph build, which scaled with
 * `O(Σ project sizes)` regardless of how few tasks the user was assigned
 * to. With this helper the cost scales with the bounded effective
 * closure of the user's own anchor set instead.
 *
 * @param conn - Active `withUserContext` transaction handle. The caller
 *   must run inside the RLS-scoped tx so the recursive joins see only
 *   rows visible to the caller.
 * @param anchorIds - Anchor task UUIDs (the user's assigned set). Empty
 *   arrays short-circuit to an empty map.
 * @param maxDepth - Maximum effective hops per direction. 64 is well past
 *   any realistic project diameter and the `CYCLE` clause makes the
 *   ceiling redundant in practice.
 * @returns Map keyed by anchor task id; anchors with no edges in either
 *   direction are absent from the map (caller treats them as zero / done).
 */
export async function fetchMyTaskDepStats(
  conn: Conn,
  anchorIds: readonly string[],
  maxDepth = 64,
): Promise<Map<string, MyTaskDepStats>> {
  const out = new Map<string, MyTaskDepStats>();
  if (anchorIds.length === 0) return out;

  type Row = {
    anchor_id: string;
    upstream_count: number | string;
    downstream_count: number | string;
    non_done_upstream_count: number | string;
    blocker_seq: number | string | null;
  };

  const rows = await executeRaw<Row>(
    conn,
    sql`
      WITH RECURSIVE
        anchor (anchor_id, project_id) AS (
          SELECT t.id, t.project_id
          FROM tasks t
          WHERE t.id = ANY(${uuidArray(anchorIds)})
        ),
        upstream (anchor_id, project_id, reached_id, reached_status, reached_seq, depth) AS (
          SELECT
            a.anchor_id,
            a.project_id,
            t.id,
            t.status,
            t.sequence_number,
            CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END
          FROM anchor a
          INNER JOIN task_edges e
            ON e.source_task_id = a.anchor_id
           AND e.edge_type = 'depends_on'
          INNER JOIN tasks t
            ON t.id = e.target_task_id
           AND t.project_id = a.project_id

          UNION ALL

          SELECT
            u.anchor_id,
            u.project_id,
            t.id,
            t.status,
            t.sequence_number,
            u.depth + CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END
          FROM upstream u
          INNER JOIN task_edges e
            ON e.source_task_id = u.reached_id
           AND e.edge_type = 'depends_on'
          INNER JOIN tasks t
            ON t.id = e.target_task_id
           AND t.project_id = u.project_id
          WHERE u.depth < ${maxDepth}
        ) CYCLE reached_id SET is_cycle USING path,
        downstream (anchor_id, project_id, reached_id, reached_status, depth) AS (
          SELECT
            a.anchor_id,
            a.project_id,
            t.id,
            t.status,
            CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END
          FROM anchor a
          INNER JOIN task_edges e
            ON e.target_task_id = a.anchor_id
           AND e.edge_type = 'depends_on'
          INNER JOIN tasks t
            ON t.id = e.source_task_id
           AND t.project_id = a.project_id

          UNION ALL

          SELECT
            d.anchor_id,
            d.project_id,
            t.id,
            t.status,
            d.depth + CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END
          FROM downstream d
          INNER JOIN task_edges e
            ON e.target_task_id = d.reached_id
           AND e.edge_type = 'depends_on'
          INNER JOIN tasks t
            ON t.id = e.source_task_id
           AND t.project_id = d.project_id
          WHERE d.depth < ${maxDepth}
        ) CYCLE reached_id SET is_cycle_d USING path_d,
        upstream_active AS (
          SELECT DISTINCT anchor_id, reached_id, reached_status, reached_seq
          FROM upstream
          WHERE NOT is_cycle
            AND reached_status <> 'cancelled'
            AND reached_id <> anchor_id
        ),
        downstream_active AS (
          SELECT DISTINCT anchor_id, reached_id
          FROM downstream
          WHERE NOT is_cycle_d
            AND reached_status <> 'cancelled'
            AND reached_id <> anchor_id
        )
      SELECT
        a.anchor_id,
        COALESCE((
          SELECT COUNT(*) FROM upstream_active u WHERE u.anchor_id = a.anchor_id
        ), 0) AS upstream_count,
        COALESCE((
          SELECT COUNT(*) FROM downstream_active d WHERE d.anchor_id = a.anchor_id
        ), 0) AS downstream_count,
        COALESCE((
          SELECT COUNT(*) FROM upstream_active u
          WHERE u.anchor_id = a.anchor_id AND u.reached_status <> 'done'
        ), 0) AS non_done_upstream_count,
        (
          SELECT MIN(u.reached_seq) FROM upstream_active u
          WHERE u.anchor_id = a.anchor_id AND u.reached_status <> 'done'
        ) AS blocker_seq
      FROM anchor a
    `,
  );

  for (const row of rows) {
    const upstreamCount = Number(row.upstream_count);
    const downstreamCount = Number(row.downstream_count);
    const nonDoneUpstream = Number(row.non_done_upstream_count);
    out.set(row.anchor_id, {
      upstreamCount,
      downstreamCount,
      allDepsDone: nonDoneUpstream === 0,
      blockerSequenceNumber:
        row.blocker_seq === null ? null : Number(row.blocker_seq),
    });
  }
  return out;
}
