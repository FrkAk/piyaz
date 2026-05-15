-- ---------------------------------------------------------------------------
-- Row-Level Security policies for public-schema tables.
-- ---------------------------------------------------------------------------
--
-- Applied after `bun run db:push` because every policy references public
-- tables (`projects`, `tasks`) that push must create first. Tables get RLS
-- enabled via `.enableRLS()` in the Drizzle schema (push handles
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` correctly); this file adds
-- the `CREATE POLICY` predicates that push cannot generate — its
-- introspection-based diff silently drops the `USING`/`WITH CHECK` clauses
-- on `pgPolicy()` declarations, so policies are managed entirely as
-- hand-written SQL.
--
-- Idempotent: each `DROP POLICY IF EXISTS` + `CREATE POLICY` pair re-applies
-- cleanly on every `db:setup` re-run. `IF EXISTS` swallows the
-- first-run case where the policy doesn't yet exist.
--
-- Predicate shape: one permissive `FOR ALL TO public` policy per table,
-- resolving membership through `neon_auth.member` keyed on
-- `NULLIF(current_setting('app.user_id', TRUE), '')::uuid`. The
-- missing-GUC path resolves to NULL so the EXISTS subquery evaluates false
-- (default-deny). `service_role` (BYPASSRLS) sidesteps policies entirely
-- without needing role-targeted exclusion.

-- projects — 1-hop
DROP POLICY IF EXISTS "projects_member_access" ON "projects";
CREATE POLICY "projects_member_access" ON "projects" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM neon_auth."member" m
    WHERE m."organizationId" = "projects"."organization_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM neon_auth."member" m
    WHERE m."organizationId" = "projects"."organization_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));

-- tasks — 2-hop via projects.organization_id
DROP POLICY IF EXISTS "tasks_member_access" ON "tasks";
CREATE POLICY "tasks_member_access" ON "tasks" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM projects p
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE p.id = "tasks"."project_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE p.id = "tasks"."project_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));

-- task_edges — 3-hop via source task → projects
DROP POLICY IF EXISTS "task_edges_member_access" ON "task_edges";
CREATE POLICY "task_edges_member_access" ON "task_edges" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_edges"."source_task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_edges"."source_task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));

-- task_assignees — 3-hop via task → projects
DROP POLICY IF EXISTS "task_assignees_member_access" ON "task_assignees";
CREATE POLICY "task_assignees_member_access" ON "task_assignees" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_assignees"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_assignees"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));

-- task_acceptance_criteria — 3-hop via task → projects
DROP POLICY IF EXISTS "task_acceptance_criteria_member_access" ON "task_acceptance_criteria";
CREATE POLICY "task_acceptance_criteria_member_access" ON "task_acceptance_criteria" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_acceptance_criteria"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_acceptance_criteria"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));

-- task_decisions — 3-hop via task → projects
DROP POLICY IF EXISTS "task_decisions_member_access" ON "task_decisions";
CREATE POLICY "task_decisions_member_access" ON "task_decisions" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_decisions"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_decisions"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));

-- task_links — 3-hop via task → projects
DROP POLICY IF EXISTS "task_links_member_access" ON "task_links";
CREATE POLICY "task_links_member_access" ON "task_links" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_links"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN neon_auth."member" m ON m."organizationId" = p.organization_id
    WHERE t.id = "task_links"."task_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));

-- team_invite_code — 1-hop
DROP POLICY IF EXISTS "team_invite_code_member_access" ON "team_invite_code";
CREATE POLICY "team_invite_code_member_access" ON "team_invite_code" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (
    SELECT 1 FROM neon_auth."member" m
    WHERE m."organizationId" = "team_invite_code"."organization_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM neon_auth."member" m
    WHERE m."organizationId" = "team_invite_code"."organization_id"
      AND m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ));
