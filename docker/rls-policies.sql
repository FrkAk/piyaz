-- Hand-written RLS policies for public.*. Drizzle's `pgPolicy()` round-trip
-- drops USING/WITH CHECK on push, so policy DDL lives here.
--
-- Membership is computed once per query via `public.current_user_org_ids()`,
-- a STABLE SECURITY DEFINER function. Wrapping the call in `(SELECT ...)`
-- forces an InitPlan; `organization_id = ANY (cached_array)` then runs as
-- a single index-scan condition per row. 2- and 3-hop tables delegate
-- through the parent table's RLS rather than duplicating the membership
-- join, so adding new auth schema columns doesn't ripple here.
--
-- `task_edges` USING and WITH CHECK both require both endpoints visible.
-- USING-side symmetry matters because Postgres does not evaluate WITH CHECK
-- on DELETE; without it, a source-side member could delete (or read) an
-- edge whose target lives in a foreign team.

-- projects — 1-hop directly on organization_id
DROP POLICY IF EXISTS "projects_member_access" ON "projects";
CREATE POLICY "projects_member_access" ON "projects" AS PERMISSIVE FOR ALL TO app_user
  USING (organization_id = ANY (public.current_user_org_ids()));

-- tasks — 2-hop via projects. Delegates to projects' RLS so the membership
-- check evaluates once at the projects layer, not per task row.
DROP POLICY IF EXISTS "tasks_member_access" ON "tasks";
CREATE POLICY "tasks_member_access" ON "tasks" AS PERMISSIVE FOR ALL TO app_user
  USING (project_id IN (SELECT id FROM public.projects));

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

-- task_assignees — 3-hop via task. Delegates to tasks' RLS.
DROP POLICY IF EXISTS "task_assignees_member_access" ON "task_assignees";
CREATE POLICY "task_assignees_member_access" ON "task_assignees" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks));

-- task_acceptance_criteria — 3-hop via task.
DROP POLICY IF EXISTS "task_acceptance_criteria_member_access" ON "task_acceptance_criteria";
CREATE POLICY "task_acceptance_criteria_member_access" ON "task_acceptance_criteria" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks));

-- task_decisions — 3-hop via task.
DROP POLICY IF EXISTS "task_decisions_member_access" ON "task_decisions";
CREATE POLICY "task_decisions_member_access" ON "task_decisions" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks));

-- task_links — 3-hop via task.
DROP POLICY IF EXISTS "task_links_member_access" ON "task_links";
CREATE POLICY "task_links_member_access" ON "task_links" AS PERMISSIVE FOR ALL TO app_user
  USING (task_id IN (SELECT id FROM public.tasks));

-- team_invite_code — split: SELECT for all members of the org, writes
-- (INSERT/UPDATE/DELETE) restricted to admin/owner roles. Defense-in-depth
-- so a bypass of the action-layer isOrgAdmin check (new endpoint, SQLi
-- landing) cannot mint or rotate codes from a regular member's session.
DROP POLICY IF EXISTS "team_invite_code_member_access" ON "team_invite_code";
DROP POLICY IF EXISTS "team_invite_code_member_select" ON "team_invite_code";
DROP POLICY IF EXISTS "team_invite_code_admin_write" ON "team_invite_code";

CREATE POLICY "team_invite_code_member_select" ON "team_invite_code"
  AS PERMISSIVE FOR SELECT TO app_user
  USING (organization_id = ANY (public.current_user_org_ids()));

CREATE POLICY "team_invite_code_admin_write" ON "team_invite_code"
  AS PERMISSIVE FOR ALL TO app_user
  USING (public.current_user_org_role(organization_id) IN ('admin', 'owner'))
  WITH CHECK (public.current_user_org_role(organization_id) IN ('admin', 'owner'));

-- WITH CHECK is explicit (not implicit-from-USING) so the INSERT-time policy
-- evaluation is unambiguous to readers and future Postgres versions can't
-- regress the behavior by tightening the implicit-reuse rule.


-- FORCE makes the table owner subject to RLS. Targets the Neon prod
-- owner (`neondb_owner`, which is NOT a superuser); BYPASSRLS roles and
-- real superusers still sidestep.
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_edges" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_assignees" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_acceptance_criteria" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_decisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_links" FORCE ROW LEVEL SECURITY;
ALTER TABLE "team_invite_code" FORCE ROW LEVEL SECURITY;
