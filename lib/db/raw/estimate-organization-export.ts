import { sql } from "drizzle-orm";
import type { ReadConn } from "@/lib/db/raw";

/** Database-side workspace export estimate. */
export type OrganizationExportEstimateRow = {
  row_count: number | string;
  estimated_bytes: number | string;
};

/**
 * Build the bounded export preflight statement for a Neon HTTP read batch.
 *
 * @param read - RLS-scoped lazy read builder.
 * @param userId - Exporting user whose own assignments are portable.
 * @param organizationId - Organization whose visible rows should be measured.
 * @returns Lazy raw statement for {@link import("@/lib/db/rls").withUserContextRead}.
 */
export function organizationExportEstimateStmt(
  read: ReadConn,
  userId: string,
  organizationId: string,
) {
  return read.execute(sql`
    WITH export_rows AS (
      SELECT to_jsonb(p) - 'organization_id' AS payload
      FROM public.projects p
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(t) AS payload
      FROM public.tasks t
      INNER JOIN public.projects p ON p.id = t.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(te) AS payload
      FROM public.task_edges te
      INNER JOIN public.tasks t ON t.id = te.source_task_id
      INNER JOIN public.projects p ON p.id = t.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(ta) - 'user_id' AS payload
      FROM public.task_assignees ta
      INNER JOIN public.tasks t ON t.id = ta.task_id
      INNER JOIN public.projects p ON p.id = t.project_id
      WHERE p.organization_id = ${organizationId}::uuid
        AND ta.user_id = ${userId}::uuid
      UNION ALL
      SELECT to_jsonb(tac) AS payload
      FROM public.task_acceptance_criteria tac
      INNER JOIN public.tasks t ON t.id = tac.task_id
      INNER JOIN public.projects p ON p.id = t.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(td) AS payload
      FROM public.task_decisions td
      INNER JOIN public.tasks t ON t.id = td.task_id
      INNER JOIN public.projects p ON p.id = t.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(tl) AS payload
      FROM public.task_links tl
      INNER JOIN public.tasks t ON t.id = tl.task_id
      INNER JOIN public.projects p ON p.id = t.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(ae) - 'actor_client_id' AS payload
      FROM public.activity_events ae
      INNER JOIN public.projects p ON p.id = ae.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(ROW(
        n.id,
        n.project_id,
        n.sequence_number,
        n.type,
        n.folder,
        n.title,
        n.slug,
        n.summary,
        n.body,
        n.visibility,
        n.shared_since,
        n.agent_writable,
        n.locked,
        n.feed_mode,
        n.feed_categories,
        n.feed_tags,
        n.tags,
        n.category,
        n.version,
        n.embedding_status,
        n.share_requested_by,
        n.created_by,
        n.updated_by,
        n.created_at,
        n.updated_at,
        n.meta_updated_at,
        n.deleted_at
      )) AS payload
      FROM public.notes n
      INNER JOIN public.projects p ON p.id = n.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(nf) - 'created_by' AS payload
      FROM public.note_folders nf
      INNER JOIN public.projects p ON p.id = nf.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(ntl) AS payload
      FROM public.note_task_links ntl
      INNER JOIN public.notes n ON n.id = ntl.note_id
      INNER JOIN public.projects p ON p.id = n.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(nft) AS payload
      FROM public.note_feed_tasks nft
      INNER JOIN public.notes n ON n.id = nft.note_id
      INNER JOIN public.projects p ON p.id = n.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(nl) AS payload
      FROM public.note_links nl
      INNER JOIN public.notes n ON n.id = nl.source_note_id
      INNER JOIN public.projects p ON p.id = n.project_id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION ALL
      SELECT to_jsonb(nr) AS payload
      FROM public.note_revisions nr
      INNER JOIN public.notes n ON n.id = nr.note_id
      INNER JOIN public.projects p ON p.id = n.project_id
      WHERE p.organization_id = ${organizationId}::uuid
    )
    SELECT
      COUNT(*)::bigint AS row_count,
      (COALESCE(SUM(octet_length(payload::text)), 0) +
        COUNT(*) * 256 + 1024)::bigint AS estimated_bytes
    FROM export_rows
  `);
}
