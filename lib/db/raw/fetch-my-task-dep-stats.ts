import { sql } from "drizzle-orm";
import { executeRaw, type Conn, uuidArray } from "@/lib/db/raw";

/**
 * Per-anchor direct-dependency stats projected from the query below.
 *
 * Counts are over direct `depends_on` edges only (no transitive walk),
 * mirroring `buildDepsMap` in the workspace structure view.
 * `blockerSequenceNumber` is the lowest `sequence_number` among direct
 * upstreams that are neither done nor cancelled, or `null` when none.
 * `allDepsDone` mirrors that signal.
 */
export type MyTaskDepStats = {
  upstreamCount: number;
  downstreamCount: number;
  allDepsDone: boolean;
  blockerSequenceNumber: number | null;
};

/**
 * Batched per-anchor direct-dependency stats for `listMyTasks`.
 *
 * For each anchor this counts its direct `depends_on` edges in both
 * directions (`upstreamCount` = tasks the anchor depends on,
 * `downstreamCount` = tasks that depend on the anchor) and finds the
 * lowest-`sequence_number` direct upstream that is neither done nor
 * cancelled (the {@link MyTaskDepStats.blockerSequenceNumber} behind the
 * `Blocked by …` chip). No transitive / cancelled-transparent walk: a
 * cancelled or done direct dep is still counted but never blocks.
 *
 * @param conn - Active `withUserContext` transaction handle so the joins
 *   see only RLS-visible rows.
 * @param anchorIds - Anchor task UUIDs (the user's assigned set). Empty
 *   arrays short-circuit to an empty map.
 * @returns Map keyed by anchor task id, one entry per anchor. Anchors with
 *   no edges return zeroed stats (counts 0, `allDepsDone` true,
 *   `blockerSequenceNumber` null).
 */
export async function fetchMyTaskDepStats(
  conn: Conn,
  anchorIds: readonly string[],
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
      SELECT
        a.id AS anchor_id,
        COALESCE(up.cnt, 0) AS upstream_count,
        COALESCE(down.cnt, 0) AS downstream_count,
        COALESCE(up.non_done, 0) AS non_done_upstream_count,
        up.blocker_seq AS blocker_seq
      FROM tasks a
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS cnt,
          COUNT(*) FILTER (
            WHERE t.status NOT IN ('done', 'cancelled')
          ) AS non_done,
          MIN(t.sequence_number) FILTER (
            WHERE t.status NOT IN ('done', 'cancelled')
          ) AS blocker_seq
        FROM task_edges e
        INNER JOIN tasks t ON t.id = e.target_task_id
        WHERE e.source_task_id = a.id
          AND e.edge_type = 'depends_on'
      ) up ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM task_edges e
        WHERE e.target_task_id = a.id
          AND e.edge_type = 'depends_on'
      ) down ON TRUE
      WHERE a.id = ANY(${uuidArray(anchorIds)})
    `,
  );

  for (const row of rows) {
    const nonDoneUpstream = Number(row.non_done_upstream_count);
    out.set(row.anchor_id, {
      upstreamCount: Number(row.upstream_count),
      downstreamCount: Number(row.downstream_count),
      allDepsDone: nonDoneUpstream === 0,
      blockerSequenceNumber:
        row.blocker_seq === null ? null : Number(row.blocker_seq),
    });
  }
  return out;
}
