-- Hand-written RLS policies for public.*. Drizzle's `pgPolicy()` drops
-- USING/WITH CHECK on push, so policy DDL lives here.
--
-- Membership is fetched once per query via `public.current_user_org_ids()`
-- (STABLE SECURITY DEFINER, returns uuid[]). The `IN (SELECT unnest(...))`
-- sublink forces an InitPlan regardless of planner heuristics.
-- 2- and 3-hop tables delegate through the parent table's RLS.
--
-- `task_edges` requires both endpoints visible on both USING and WITH
-- CHECK — Postgres does not evaluate WITH CHECK on DELETE, so USING-side
-- symmetry is what blocks a source-side member from deleting an edge
-- whose target lives in a foreign team.

-- projects — 1-hop on organization_id; InitPlan materializes the
-- membership array once per query.
DROP POLICY IF EXISTS "projects_member_access" ON "projects";
CREATE POLICY "projects_member_access" ON "projects" AS PERMISSIVE FOR ALL TO app_user
  USING (organization_id IN (SELECT unnest(public.current_user_org_ids())));

-- tasks — 2-hop via projects' RLS. Explicit WITH CHECK so future Postgres
-- versions can't regress the implicit-from-USING fallback.
DROP POLICY IF EXISTS "tasks_member_access" ON "tasks";
CREATE POLICY "tasks_member_access" ON "tasks" AS PERMISSIVE FOR ALL TO app_user
  USING (project_id IN (SELECT id FROM public.projects))
  WITH CHECK (project_id IN (SELECT id FROM public.projects));

-- task_edges — both endpoints must be visible (see header on the DELETE quirk).
DROP POLICY IF EXISTS "task_edges_member_access" ON "task_edges";
CREATE POLICY "task_edges_member_access" ON "task_edges" AS PERMISSIVE FOR ALL TO app_user
  USING (
    source_task_id IN (SELECT id FROM public.tasks)
    AND target_task_id IN (SELECT id FROM public.tasks)
  )
  WITH CHECK (
    source_task_id IN (SELECT id FROM public.tasks)
    AND target_task_id IN (SELECT id FROM public.tasks)
  );

-- task_assignees — 3-hop via tasks' RLS.
DROP POLICY IF EXISTS "task_assignees_member_access" ON "task_assignees";
CREATE POLICY "task_assignees_member_access" ON "task_assignees" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks))
  WITH CHECK (task_id IN (SELECT id FROM public.tasks));

-- task_acceptance_criteria — 3-hop via task.
DROP POLICY IF EXISTS "task_acceptance_criteria_member_access" ON "task_acceptance_criteria";
CREATE POLICY "task_acceptance_criteria_member_access" ON "task_acceptance_criteria" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks))
  WITH CHECK (task_id IN (SELECT id FROM public.tasks));

-- task_decisions — 3-hop via task.
DROP POLICY IF EXISTS "task_decisions_member_access" ON "task_decisions";
CREATE POLICY "task_decisions_member_access" ON "task_decisions" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks))
  WITH CHECK (task_id IN (SELECT id FROM public.tasks));

-- task_links — 3-hop via task.
DROP POLICY IF EXISTS "task_links_member_access" ON "task_links";
CREATE POLICY "task_links_member_access" ON "task_links" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks))
  WITH CHECK (task_id IN (SELECT id FROM public.tasks));

-- activity_events: 2-hop via projects' RLS, mirroring tasks. USING also
-- gates note_id-bearing rows through the notes RLS with a correlated EXISTS
-- (one notes_pkey probe; notes_member_access hides other users' private
-- notes, so the probe fails closed and private-note events stay invisible to
-- other members). The WITH CHECK pins a non-null task_id or note_id to the
-- row's own project, so a member cannot write an event whose project_id is
-- theirs but whose task_id/note_id belongs to a foreign project (those
-- columns otherwise carry no policy predicate). Both sub-probes are
-- RLS-scoped, so a cross-project target is invisible and the check fails
-- closed.
DROP POLICY IF EXISTS "activity_events_member_access" ON "activity_events";
CREATE POLICY "activity_events_member_access" ON "activity_events" AS PERMISSIVE FOR ALL TO app_user
  USING (
    project_id IN (SELECT id FROM public.projects)
    AND (
      note_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.notes n
        WHERE n.id = activity_events.note_id
      )
    )
  )
  WITH CHECK (
    project_id IN (SELECT id FROM public.projects)
    AND (
      task_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.tasks t
        WHERE t.id = activity_events.task_id
          AND t.project_id = activity_events.project_id
      )
    )
    AND (
      note_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.notes n
        WHERE n.id = activity_events.note_id
          AND n.project_id = activity_events.project_id
      )
    )
  );

-- RESTRICTIVE write floor on task_edges. RESTRICTIVE AND's with the OR of
-- permissives, so a future stray permissive cannot OR-relax both-endpoints
-- -visible. Scoped per-command to leave SELECT on the permissive policy.
DROP POLICY IF EXISTS "task_edges_insert_member_only" ON "task_edges";
DROP POLICY IF EXISTS "task_edges_update_member_only" ON "task_edges";
DROP POLICY IF EXISTS "task_edges_delete_member_only" ON "task_edges";

CREATE POLICY "task_edges_insert_member_only" ON "task_edges"
  AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (
    source_task_id IN (SELECT id FROM public.tasks)
    AND target_task_id IN (SELECT id FROM public.tasks)
  );

CREATE POLICY "task_edges_update_member_only" ON "task_edges"
  AS RESTRICTIVE FOR UPDATE TO app_user
  USING (
    source_task_id IN (SELECT id FROM public.tasks)
    AND target_task_id IN (SELECT id FROM public.tasks)
  )
  WITH CHECK (
    source_task_id IN (SELECT id FROM public.tasks)
    AND target_task_id IN (SELECT id FROM public.tasks)
  );

CREATE POLICY "task_edges_delete_member_only" ON "task_edges"
  AS RESTRICTIVE FOR DELETE TO app_user
  USING (
    source_task_id IN (SELECT id FROM public.tasks)
    AND target_task_id IN (SELECT id FROM public.tasks)
  );

-- team_invite_code — admin/owner only on every command (including SELECT).
-- Regular members never need the raw `code`; redemption SDFs are
-- SECURITY DEFINER and sidestep the policy so the join flow still works.
DROP POLICY IF EXISTS "team_invite_code_member_access" ON "team_invite_code";
DROP POLICY IF EXISTS "team_invite_code_member_select" ON "team_invite_code";
DROP POLICY IF EXISTS "team_invite_code_admin_write" ON "team_invite_code";

CREATE POLICY "team_invite_code_admin_write" ON "team_invite_code"
  AS PERMISSIVE FOR ALL TO app_user
  USING (public.current_user_org_role(organization_id) IN ('admin', 'owner'))
  WITH CHECK (public.current_user_org_role(organization_id) IN ('admin', 'owner'));

-- RESTRICTIVE write floor — locks admin/owner-only against a future stray
-- permissive. Per-command so member SELECT is unaffected.
DROP POLICY IF EXISTS "team_invite_code_write_admin_only" ON "team_invite_code";
DROP POLICY IF EXISTS "team_invite_code_insert_admin_only" ON "team_invite_code";
DROP POLICY IF EXISTS "team_invite_code_update_admin_only" ON "team_invite_code";
DROP POLICY IF EXISTS "team_invite_code_delete_admin_only" ON "team_invite_code";

CREATE POLICY "team_invite_code_insert_admin_only" ON "team_invite_code"
  AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (public.current_user_org_role(organization_id) IN ('admin', 'owner'));

CREATE POLICY "team_invite_code_update_admin_only" ON "team_invite_code"
  AS RESTRICTIVE FOR UPDATE TO app_user
  USING (public.current_user_org_role(organization_id) IN ('admin', 'owner'))
  WITH CHECK (public.current_user_org_role(organization_id) IN ('admin', 'owner'));

CREATE POLICY "team_invite_code_delete_admin_only" ON "team_invite_code"
  AS RESTRICTIVE FOR DELETE TO app_user
  USING (public.current_user_org_role(organization_id) IN ('admin', 'owner'));


-- notes — 2-hop via projects' RLS, plus per-note visibility. deleted_at
-- filtering is a query concern, not RLS. The per-row predicate columns
-- (visibility, created_by) are leakproof plain comparisons, so they are safe
-- to evaluate on every scanned row; the caller lookup is wrapped in
-- (SELECT ...) so it evaluates once per statement as an InitPlan — same
-- discipline as the current_user_org_ids() sublink (header) — instead of
-- paying a plpgsql call per scanned private row. Attribution is pinned end to
-- end: the notes_insert_author_only floor below fixes created_by (and
-- updated_by/share_requested_by) to the caller on INSERT (this permissive
-- WITH CHECK OR-s past created_by on a visibility='team' insert), and the
-- notes_created_by_immutable / notes_attribution_pinned triggers
-- (rls-functions.sql) guard them on UPDATE, so a member can neither forge a
-- team note's attribution nor privatize-and-steal one.
DROP POLICY IF EXISTS "notes_member_access" ON "notes";
CREATE POLICY "notes_member_access" ON "notes" AS PERMISSIVE FOR ALL TO app_user
  USING (
    project_id IN (SELECT id FROM public.projects)
    AND (visibility = 'team'
         OR created_by = (SELECT public.current_app_user_id()))
  )
  WITH CHECK (
    project_id IN (SELECT id FROM public.projects)
    AND (visibility = 'team'
         OR created_by = (SELECT public.current_app_user_id()))
  );

-- RESTRICTIVE INSERT floor pinning attribution to the caller. The permissive
-- notes_member_access WITH CHECK OR-s on visibility='team', so it never evaluates
-- created_by on a team-note INSERT — without this floor a member could insert a
-- team note attributed to any other user. RESTRICTIVE AND's with the permissive,
-- forcing every inserted note to be self-authored (mirrors the note_revisions
-- created_by pin and the note_links insert floor). Strict equality on created_by
-- (no NULL): a fresh note always has an author, and a NULL-author private note is
-- invisible to everyone. updated_by/share_requested_by start NULL or as the
-- caller, never another user. INSERT-only; the UPDATE path is covered by the
-- notes_created_by_immutable and notes_attribution_pinned triggers.
DROP POLICY IF EXISTS "notes_insert_author_only" ON "notes";
CREATE POLICY "notes_insert_author_only" ON "notes"
  AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (
    created_by = (SELECT public.current_app_user_id())
    AND (updated_by IS NULL
         OR updated_by = (SELECT public.current_app_user_id()))
    AND (share_requested_by IS NULL
         OR share_requested_by = (SELECT public.current_app_user_id()))
  );

-- note_task_links — both endpoints checked in RLS (mirror task_edges): the
-- note via notes' RLS and the task via tasks' RLS. The same-project belt is
-- the SECURITY INVOKER trigger reject_note_task_links_cross_project
-- (rls-functions.sql); the task-side predicate here is a second floor for the
-- trigger-loss case and never rejects a legitimate row (the trigger pins
-- note.project_id == task's).
--
-- Endpoint checks on the notes-family link/revision tables are correlated
-- EXISTS, not `IN (SELECT id FROM ...)`: every policy clause carrying an
-- IN-sublist plans its own hashed SubPlan over the caller's ENTIRE visible-
-- notes set (each row re-paying notes' RLS), so a single-row write evaluates
-- that set up to six times (permissive + restrictive × USING + WITH CHECK).
-- A correlated EXISTS is one notes_pkey probe per check with identical
-- RLS-filtered semantics (same pattern as the activity_events task probe).
DROP POLICY IF EXISTS "note_task_links_member_access" ON "note_task_links";
CREATE POLICY "note_task_links_member_access" ON "note_task_links" AS PERMISSIVE FOR ALL TO app_user
  USING (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_task_links.note_id)
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = note_task_links.task_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_task_links.note_id)
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = note_task_links.task_id)
  );

-- RESTRICTIVE write floor on note_task_links (mirror note_links / task_edges).
-- AND's with the OR of permissives so a future stray permissive cannot
-- OR-relax both-endpoints-visible. Per-command to leave SELECT on permissive.
DROP POLICY IF EXISTS "note_task_links_insert_member_only" ON "note_task_links";
DROP POLICY IF EXISTS "note_task_links_update_member_only" ON "note_task_links";
DROP POLICY IF EXISTS "note_task_links_delete_member_only" ON "note_task_links";

CREATE POLICY "note_task_links_insert_member_only" ON "note_task_links"
  AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_task_links.note_id)
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = note_task_links.task_id)
  );

CREATE POLICY "note_task_links_update_member_only" ON "note_task_links"
  AS RESTRICTIVE FOR UPDATE TO app_user
  USING (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_task_links.note_id)
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = note_task_links.task_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_task_links.note_id)
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = note_task_links.task_id)
  );

CREATE POLICY "note_task_links_delete_member_only" ON "note_task_links"
  AS RESTRICTIVE FOR DELETE TO app_user
  USING (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_task_links.note_id)
    AND EXISTS (SELECT 1 FROM public.tasks t WHERE t.id = note_task_links.task_id)
  );

-- note_revisions — 3-hop via notes' RLS (append-only body history). WITH CHECK
-- also pins created_by to the caller (or NULL) so a member cannot forge a
-- snapshot attributed to another user; UPDATE is revoked in grants.sql.
-- Correlated EXISTS per the note_task_links rationale above.
DROP POLICY IF EXISTS "note_revisions_member_access" ON "note_revisions";
CREATE POLICY "note_revisions_member_access" ON "note_revisions" AS PERMISSIVE FOR ALL TO app_user
  USING (EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_revisions.note_id))
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_revisions.note_id)
    AND (created_by IS NULL
         OR created_by = (SELECT public.current_app_user_id()))
  );

-- RESTRICTIVE INSERT floor re-pinning snapshot authorship (mirror
-- notes_insert_author_only / task_edges_*_member_only): a future stray
-- permissive cannot OR-relax the created_by pin above. NULL stays allowed —
-- an unattributed snapshot is a documented design choice.
DROP POLICY IF EXISTS "note_revisions_insert_author_only" ON "note_revisions";
CREATE POLICY "note_revisions_insert_author_only" ON "note_revisions"
  AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (
    created_by IS NULL
    OR created_by = (SELECT public.current_app_user_id())
  );

-- note_links — both endpoints must be visible (mirror task_edges).
-- Correlated EXISTS per the note_task_links rationale above.
DROP POLICY IF EXISTS "note_links_member_access" ON "note_links";
CREATE POLICY "note_links_member_access" ON "note_links" AS PERMISSIVE FOR ALL TO app_user
  USING (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.source_note_id)
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.target_note_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.source_note_id)
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.target_note_id)
  );

-- RESTRICTIVE write floor on note_links (mirror task_edges_*_member_only).
-- AND's with the OR of permissives so a future stray permissive cannot
-- OR-relax both-endpoints-visible. Per-command to leave SELECT on permissive.
DROP POLICY IF EXISTS "note_links_insert_member_only" ON "note_links";
DROP POLICY IF EXISTS "note_links_update_member_only" ON "note_links";
DROP POLICY IF EXISTS "note_links_delete_member_only" ON "note_links";

CREATE POLICY "note_links_insert_member_only" ON "note_links"
  AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.source_note_id)
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.target_note_id)
  );

CREATE POLICY "note_links_update_member_only" ON "note_links"
  AS RESTRICTIVE FOR UPDATE TO app_user
  USING (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.source_note_id)
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.target_note_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.source_note_id)
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.target_note_id)
  );

CREATE POLICY "note_links_delete_member_only" ON "note_links"
  AS RESTRICTIVE FOR DELETE TO app_user
  USING (
    EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.source_note_id)
    AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_links.target_note_id)
  );

-- note_folders: 2-hop via projects' RLS. Rows are explicit empty-folder
-- markers: team-visible structural metadata (paths only, no note content),
-- deliberately project-scoped rather than per-creator; a per-creator scope
-- would turn the (project_id, path) unique index into a cross-user existence
-- oracle via insert conflicts and split the tree per member. The RESTRICTIVE
-- INSERT floor pins created_by to the caller (mirror
-- notes_insert_author_only) so a member cannot forge folder attribution.
DROP POLICY IF EXISTS "note_folders_member_access" ON "note_folders";
CREATE POLICY "note_folders_member_access" ON "note_folders" AS PERMISSIVE FOR ALL TO app_user
  USING (project_id IN (SELECT id FROM public.projects))
  WITH CHECK (project_id IN (SELECT id FROM public.projects));

DROP POLICY IF EXISTS "note_folders_insert_author_only" ON "note_folders";
CREATE POLICY "note_folders_insert_author_only" ON "note_folders"
  AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (created_by = (SELECT public.current_app_user_id()));


-- ENABLE explicitly: testcontainer/self-host get this from `drizzle-kit
-- push` reading `.enableRLS()`, but `drizzle-kit migrate` does not emit
-- ENABLE, and FORCE without ENABLE is a no-op.
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_edges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_assignees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_acceptance_criteria" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_invite_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_task_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_folders" ENABLE ROW LEVEL SECURITY;

-- FORCE subjects the table owner to RLS. BYPASSRLS roles and real
-- superusers still sidestep.
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_edges" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_assignees" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_acceptance_criteria" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_decisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_links" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_invite_code" FORCE ROW LEVEL SECURITY;
ALTER TABLE "activity_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "note_task_links" FORCE ROW LEVEL SECURITY;
ALTER TABLE "note_links" FORCE ROW LEVEL SECURITY;
ALTER TABLE "note_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "note_folders" FORCE ROW LEVEL SECURITY;
