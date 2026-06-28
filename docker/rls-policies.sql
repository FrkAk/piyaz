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

-- activity_events — 2-hop via projects' RLS, mirroring tasks. The WITH CHECK
-- also pins a non-null task_id to the row's own project, so a member cannot
-- write an event whose project_id is theirs but whose task_id belongs to a
-- foreign project (the task_id column otherwise carries no policy predicate).
-- The tasks sub-probe is RLS-scoped, so a cross-project task is invisible and
-- the check fails closed.
DROP POLICY IF EXISTS "activity_events_member_access" ON "activity_events";
CREATE POLICY "activity_events_member_access" ON "activity_events" AS PERMISSIVE FOR ALL TO app_user
  USING (project_id IN (SELECT id FROM public.projects))
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
