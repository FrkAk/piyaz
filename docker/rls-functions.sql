-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers reachable from app_user.
--
-- Every body is plpgsql (never inlined — CVE-2022-1552 class) and pins
-- search_path with `pg_temp` last (CVE-2018-1058 class). EXECUTE is granted
-- per-function below; PUBLIC is denied everywhere.
--
-- KEEP IN SYNC WITH lib/data/team-invite-code.ts (JS callers).
--
-- OWNER-MANAGED. NOT applied by db:migrate. These run as their owner
-- (SECURITY DEFINER) and several read piyaz_auth, so they must be owned by the
-- database owner (the role with auth-schema access), not a least-privilege
-- migration role. To change one: edit this file, then re-apply it as the
-- database owner; it is idempotent (CREATE OR REPLACE). Never hand-edit
-- functions on a live database.
-- ---------------------------------------------------------------------------

-- Diagnostic only: returns four non-identifying fields so a guessed code
-- cannot resolve to a real org. Service-role only — prevents app_user (or
-- an SQLi sink against it) from enumerating code validity at scale.
CREATE OR REPLACE FUNCTION public.lookup_team_invite_code(p_code text)
RETURNS TABLE (
  revoked_at timestamptz,
  expires_at timestamptz,
  max_uses integer,
  use_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT t.revoked_at, t.expires_at, t.max_uses, t.use_count
  FROM public.team_invite_code t
  WHERE t.code = p_code
  LIMIT 1;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.lookup_team_invite_code(text) FROM public;
REVOKE EXECUTE ON FUNCTION public.lookup_team_invite_code(text) FROM app_user;
GRANT EXECUTE ON FUNCTION public.lookup_team_invite_code(text) TO service_role;

-- Atomically reserve a slot on a valid code. Returns row identifiers on
-- success, empty set on any failure (anti-enumeration).
--
-- Pre-sweep reclaims a stale reservation on the same row (handles crash
-- between reserve and release). The FOR UPDATE row lock serializes
-- concurrent reservers — closes the read-committed
-- `max_uses + (concurrency-1)` overflow window from EvalPlanQual rechecks.
--
-- Caller binding: aborts unless `p_user_id` matches the session's
-- `app.user_id` GUC. Without this, an SQLi sink under `app_user` could
-- burn slots on guessed codes or recover an org/default_role pair under
-- a forged identity. Empty-set (not RAISE) on mismatch preserves
-- anti-enumeration. JS callers MUST enter through `withUserContext`.
DROP FUNCTION IF EXISTS public.reserve_team_invite_code_slot(text);
CREATE OR REPLACE FUNCTION public.reserve_team_invite_code_slot(p_code text, p_user_id uuid)
RETURNS TABLE (id uuid, organization_id uuid, default_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  IF p_user_id::text IS DISTINCT FROM current_setting('app.user_id', TRUE) THEN
    RETURN;
  END IF;

  UPDATE public.team_invite_code AS t
     SET use_count = GREATEST(t.use_count - 1, 0),
         reserved_until = NULL,
         reserved_by = NULL,
         updated_at = NOW()
   WHERE t.code = p_code
     AND t.reserved_until IS NOT NULL
     AND t.reserved_until < NOW();

  PERFORM 1 FROM public.team_invite_code WHERE code = p_code FOR UPDATE;

  RETURN QUERY
  UPDATE public.team_invite_code AS t
     SET use_count = t.use_count + 1,
         reserved_until = NOW() + interval '15 minutes',
         reserved_by = p_user_id,
         updated_at = NOW()
   WHERE t.code = p_code
     AND t.revoked_at IS NULL
     AND (t.expires_at IS NULL OR t.expires_at > NOW())
     AND (t.max_uses IS NULL OR t.use_count < t.max_uses)
  RETURNING t.id, t.organization_id, t.default_role;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reserve_team_invite_code_slot(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.reserve_team_invite_code_slot(text, uuid) TO app_user;

-- Finalize a reservation. Caller passes the explicit `p_succeeded` — the
-- JS layer is the only place that can distinguish "saga created the
-- member row" from "caller was already a member before reserve", so the
-- SDF must not infer it.
--
-- Gates on `reserved_by = p_user_id` so an attacker who learns a row UUID
-- cannot release someone else's reservation. Mismatches match zero rows
-- and return false.
--
-- Outcomes:
--   p_succeeded = true  → keep use_count, clear reservation.
--   p_succeeded = false → decrement use_count (floored at 0), clear reservation.
--
-- Idempotent: a second call matches zero rows because `reserved_until`
-- is already cleared.
DROP FUNCTION IF EXISTS public.release_team_invite_code_slot(uuid);
CREATE OR REPLACE FUNCTION public.release_team_invite_code_slot(
  p_id uuid,
  p_user_id uuid,
  p_succeeded boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_matched integer;
BEGIN
  UPDATE public.team_invite_code AS t
     SET use_count = CASE
           WHEN p_succeeded THEN t.use_count
           ELSE GREATEST(t.use_count - 1, 0)
         END,
         reserved_until = NULL,
         reserved_by = NULL,
         updated_at = NOW()
   WHERE t.id = p_id
     AND t.reserved_by = p_user_id
     AND t.reserved_until IS NOT NULL;
  GET DIAGNOSTICS v_matched = ROW_COUNT;
  RETURN v_matched = 1;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.release_team_invite_code_slot(uuid, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.release_team_invite_code_slot(uuid, uuid, boolean) TO app_user;

-- Admin lookup: project ids for an org without caller-membership scope.
-- Used by `revokeOrgAccess` in the `afterRemoveMember` hook where the
-- caller's membership row is already gone. EXECUTE granted to
-- service_role only — app_user access would expose cross-org enumeration.
CREATE OR REPLACE FUNCTION public.list_org_project_ids(p_org_id uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id FROM public.projects p WHERE p.organization_id = p_org_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.list_org_project_ids(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.list_org_project_ids(uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- current_user_* helpers — app_user's only path to piyaz_auth.*.
-- STABLE plpgsql; pinned search_path defeats piyaz_auth.* shadowing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_user_org_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(
      array_agg("organizationId") FILTER (WHERE "organizationId" IS NOT NULL),
      ARRAY[]::uuid[]
    )
    FROM piyaz_auth."member"
    WHERE "userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_org_ids() FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_org_ids() TO app_user;

CREATE OR REPLACE FUNCTION public.current_user_org_role(p_org_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role
  FROM piyaz_auth."member"
  WHERE "organizationId" = p_org_id
    AND "userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  LIMIT 1;
  RETURN v_role;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_org_role(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_org_role(uuid) TO app_user;

-- member_count is correlated so the team-list UI gets it in one roundtrip
-- instead of issuing a second aggregation query.
CREATE OR REPLACE FUNCTION public.current_user_orgs()
RETURNS TABLE (
  org_id uuid,
  name text,
  slug text,
  member_role text,
  member_count integer,
  member_created_at timestamptz,
  org_created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id,
    o.name,
    o.slug,
    m.role,
    (SELECT count(*)::int FROM piyaz_auth."member" mc WHERE mc."organizationId" = o.id) AS member_count,
    m."createdAt",
    o."createdAt"
  FROM piyaz_auth."member" m
  INNER JOIN piyaz_auth."organization" o ON o.id = m."organizationId"
  WHERE m."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  ORDER BY m."createdAt" ASC, o.id ASC;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_orgs() FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_orgs() TO app_user;

CREATE OR REPLACE FUNCTION public.current_user_has_any_membership()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM piyaz_auth."member"
    WHERE "userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_has_any_membership() FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_has_any_membership() TO app_user;

-- Resolve the caller's user id from the `app.user_id` GUC set by
-- `withUserContext` (lib/db/rls.ts). Plain SECURITY INVOKER — it only reads a
-- session setting and touches no privileged schema, unlike the piyaz_auth-reading
-- current_user_* helpers above, so it needs no DEFINER escalation. Used by the
-- notes_member_access policy's per-note visibility predicate (created_by = caller).
CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN NULLIF(current_setting('app.user_id', TRUE), '')::uuid;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.current_app_user_id() FROM public;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO app_user, service_role;

-- Returns NULL on both "doesn't exist" and "exists but cross-team", so
-- callers cannot distinguish them (anti-enumeration).
CREATE OR REPLACE FUNCTION public.current_user_visible_member(p_member_id uuid)
RETURNS TABLE (id uuid, role text, organization_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.role, m."organizationId"
  FROM piyaz_auth."member" m
  WHERE m.id = p_member_id
    AND EXISTS (
      SELECT 1
      FROM piyaz_auth."member" caller
      WHERE caller."organizationId" = m."organizationId"
        AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    )
  LIMIT 1;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.current_user_visible_member(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.current_user_visible_member(uuid) TO app_user;

CREATE OR REPLACE FUNCTION public.team_member_roles_visible(p_org_id uuid)
RETURNS TABLE (role text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT m.role
  FROM piyaz_auth."member" m
  WHERE m."organizationId" = p_org_id
    AND EXISTS (
      SELECT 1
      FROM piyaz_auth."member" caller
      WHERE caller."organizationId" = p_org_id
        AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.team_member_roles_visible(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.team_member_roles_visible(uuid) TO app_user;

-- Legacy SDFs without TS callers: dropped so re-running this file keeps
-- prod in lockstep. Reintroduce alongside a JS caller if a future UI
-- surface needs them.
DROP FUNCTION IF EXISTS public.team_members_visible(uuid);
DROP FUNCTION IF EXISTS public.team_invitations_visible(uuid);

-- Non-shared users are filtered out so the caller cannot probe arbitrary
-- uuids for existence. Caller is rate-limited at the action layer; the
-- cardinality cap below is the in-DB belt that bounds worst-case work
-- regardless of action-layer behavior.
CREATE OR REPLACE FUNCTION public.lookup_user_names_in_shared_orgs(p_user_ids uuid[])
RETURNS TABLE (id uuid, name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  IF cardinality(p_user_ids) > 1000 THEN
    RAISE EXCEPTION 'lookup_user_names_in_shared_orgs: too many ids (max 1000)'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT u.id, u.name
  FROM piyaz_auth."user" u
  WHERE u.id = ANY (p_user_ids)
    AND EXISTS (
      SELECT 1
      FROM piyaz_auth."member" m1
      INNER JOIN piyaz_auth."member" m2
        ON m2."organizationId" = m1."organizationId"
      WHERE m1."userId" = u.id
        AND m2."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.lookup_user_names_in_shared_orgs(uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.lookup_user_names_in_shared_orgs(uuid[]) TO app_user;

-- Assignees of a task, visible to members of the task's org. Membership
-- is re-checked inside the function so an upstream regression cannot
-- leak assignee identity cross-team.
--
-- `email` is intentionally exposed to every member of the task's org —
-- matches the team-roster surface. Tightening here requires tightening
-- the team-roster query in lockstep.
CREATE OR REPLACE FUNCTION public.task_assignees_visible(p_task_id uuid)
RETURNS TABLE (user_id uuid, name text, email text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT ta.user_id, u.name, u.email
  FROM public.task_assignees ta
  INNER JOIN piyaz_auth."user" u ON u.id = ta.user_id
  WHERE ta.task_id = p_task_id
    AND EXISTS (
      SELECT 1
      FROM public.tasks t
      INNER JOIN public.projects pj ON pj.id = t.project_id
      INNER JOIN piyaz_auth."member" caller
        ON caller."organizationId" = pj.organization_id
      WHERE t.id = p_task_id
        AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    )
  ORDER BY u.name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.task_assignees_visible(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.task_assignees_visible(uuid) TO app_user;

-- Resolve the distinct actor profiles for a task's activity events. Gated on
-- the caller's membership of the task's org, like task_assignees_visible.
CREATE OR REPLACE FUNCTION public.activity_actors_visible(p_task_id uuid)
RETURNS TABLE (user_id uuid, name text, image text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT u.id, u.name, u.image
  FROM public.activity_events ae
  INNER JOIN piyaz_auth."user" u ON u.id = ae.actor_user_id
  WHERE ae.task_id = p_task_id
    AND EXISTS (
      SELECT 1
      FROM public.tasks t
      INNER JOIN public.projects pj ON pj.id = t.project_id
      INNER JOIN piyaz_auth."member" caller
        ON caller."organizationId" = pj.organization_id
      WHERE t.id = p_task_id
        AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.activity_actors_visible(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.activity_actors_visible(uuid) TO app_user;

-- Resolve a single OAuth client display name (not secret). Scalar to avoid
-- text[] array binding on the read path; callers loop the page's few ids.
-- Gated like the other actor SDFs: the name is disclosed only to a caller that
-- shares an org with an activity event attributed to that client. On the read
-- path this only ever asks about clients already on visible rows. The gate is
-- an org-scoping check, not a hard anti-enumeration barrier — an app_user that
-- can insert its own events (e.g. via SQLi) could attribute a row to a guessed
-- clientId and read its name; the disclosed value is a registered display name
-- (low sensitivity), never a secret.
CREATE OR REPLACE FUNCTION public.oauth_client_name(p_client_id text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, piyaz_auth, pg_catalog, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  SELECT c.name INTO v_name
  FROM piyaz_auth."oauthClient" c
  WHERE c."clientId" = p_client_id
    AND EXISTS (
      SELECT 1
      FROM public.activity_events ae
      INNER JOIN public.projects pj ON pj.id = ae.project_id
      INNER JOIN piyaz_auth."member" caller
        ON caller."organizationId" = pj.organization_id
      WHERE ae.actor_client_id = p_client_id
        AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    );
  RETURN v_name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.oauth_client_name(text) FROM public;
GRANT EXECUTE ON FUNCTION public.oauth_client_name(text) TO app_user;

-- Per-project sibling of task_assignees_visible: one membership probe
-- for the whole project instead of N (old LATERAL pattern). Probing a
-- foreign project UUID is indistinguishable from a missing one.
CREATE OR REPLACE FUNCTION public.task_assignees_for_project_visible(
  p_project_id uuid
)
RETURNS TABLE (task_id uuid, user_id uuid, name text, email text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT ta.task_id, ta.user_id, u.name, u.email
  FROM public.tasks t
  INNER JOIN public.task_assignees ta ON ta.task_id = t.id
  INNER JOIN piyaz_auth."user" u ON u.id = ta.user_id
  WHERE t.project_id = p_project_id
    AND EXISTS (
      SELECT 1
      FROM public.projects pj
      INNER JOIN piyaz_auth."member" caller
        ON caller."organizationId" = pj.organization_id
      WHERE pj.id = p_project_id
        AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    )
  ORDER BY ta.task_id, u.name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.task_assignees_for_project_visible(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.task_assignees_for_project_visible(uuid) TO app_user;

-- Validates that every supplied user id is a member of the given org.
-- Returns the subset that ARE members; the TS caller derives the missing
-- set. Used by assignee writes to fail-fast before inserting orphan rows.
-- Caller-membership self-check keeps the function from leaking membership
-- of foreign orgs.
CREATE OR REPLACE FUNCTION public.org_member_user_ids_visible(
  p_org_id uuid,
  p_user_ids uuid[]
)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT m."userId"
  FROM piyaz_auth."member" m
  WHERE m."organizationId" = p_org_id
    AND m."userId" = ANY (p_user_ids)
    AND EXISTS (
      SELECT 1
      FROM piyaz_auth."member" caller
      WHERE caller."organizationId" = p_org_id
        AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
    );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.org_member_user_ids_visible(uuid, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.org_member_user_ids_visible(uuid, uuid[]) TO app_user;

-- Boolean: caller is a member of the invitation's org AND
-- `p_expected_org_id` matches the invitation's `organizationId`.
-- Never discloses the org id — caller must already hold (and be a member
-- of) the correct org to learn anything.
DROP FUNCTION IF EXISTS public.lookup_invitation_org_id(uuid);

CREATE OR REPLACE FUNCTION public.is_caller_in_invitation_org(
  p_invitation_id uuid,
  p_expected_org_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM piyaz_auth.invitation i
    INNER JOIN piyaz_auth."member" caller
      ON caller."organizationId" = i."organizationId"
    WHERE i.id = p_invitation_id
      AND i."organizationId" = p_expected_org_id
      AND caller."userId" = NULLIF(current_setting('app.user_id', TRUE), '')::uuid
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.is_caller_in_invitation_org(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.is_caller_in_invitation_org(uuid, uuid) TO app_user;

-- ---------------------------------------------------------------------------
-- Immutability triggers — block cross-team moves at the DB level.
-- RLS WITH CHECK passes when a dual-org member is in both source and
-- target, so the trigger rejects the column change independent of RLS.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_projects_organization_id_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION
      'projects.organization_id is immutable — cross-team project moves are forbidden'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_organization_id_immutable ON public.projects;
CREATE TRIGGER projects_organization_id_immutable
  BEFORE UPDATE OF organization_id ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_projects_organization_id_change();

CREATE OR REPLACE FUNCTION public.reject_tasks_project_id_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION
      'tasks.project_id is immutable — cross-team task moves are forbidden'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_project_id_immutable ON public.tasks;
CREATE TRIGGER tasks_project_id_immutable
  BEFORE UPDATE OF project_id ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_tasks_project_id_change();

-- Block cross-team reparenting. Without this, a dual-admin attacker
-- could pass USING(OLD) + WITH CHECK(NEW) and move team A's code into
-- team B. The trigger is unconditional regardless of RLS evaluation order.
CREATE OR REPLACE FUNCTION public.reject_team_invite_code_organization_id_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION
      'team_invite_code.organization_id is immutable — cross-team reparenting is forbidden'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_invite_code_organization_id_immutable ON public.team_invite_code;
CREATE TRIGGER team_invite_code_organization_id_immutable
  BEFORE UPDATE OF organization_id ON public.team_invite_code
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_team_invite_code_organization_id_change();

-- Reject task_edges rows whose endpoints don't share a project (or whose
-- endpoints are missing/invisible). RLS only verifies endpoint visibility;
-- a dual-org member could otherwise wire cross-project edges and leak
-- task ids through edge metadata.
--
-- SECURITY DEFINER so the per-row `tasks` lookups bypass RLS — the
-- function sees both endpoints unconditionally. The uniform error
-- collapses what would be a 4-state oracle (both invisible / one
-- visible / different projects / same project) into one failure shape.
-- INSERT/UPDATE is still gated by the table's RLS, so DEFINER here
-- cannot wire foreign edges, only validate them uniformly.
CREATE OR REPLACE FUNCTION public.reject_task_edges_cross_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_source_project uuid;
  v_target_project uuid;
BEGIN
  SELECT project_id INTO v_source_project
  FROM public.tasks WHERE id = NEW.source_task_id;
  SELECT project_id INTO v_target_project
  FROM public.tasks WHERE id = NEW.target_task_id;

  IF v_source_project IS NULL
     OR v_target_project IS NULL
     OR v_source_project IS DISTINCT FROM v_target_project THEN
    RAISE EXCEPTION 'task_edges: invalid endpoint pair'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Postgres checks EXECUTE on the trigger function against the firing
-- role; without this grant, every app_user write on task_edges fails.
REVOKE EXECUTE ON FUNCTION public.reject_task_edges_cross_project() FROM public;
GRANT EXECUTE ON FUNCTION public.reject_task_edges_cross_project() TO app_user;

DROP TRIGGER IF EXISTS task_edges_same_project_immutable ON public.task_edges;
CREATE TRIGGER task_edges_same_project_immutable
  BEFORE INSERT OR UPDATE OF source_task_id, target_task_id ON public.task_edges
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_task_edges_cross_project();

-- ---------------------------------------------------------------------------
-- Notes hardening — mirror the tasks/task_edges defense-in-depth suite.
-- notes.project_id immutability, attribution pinning, and cross-project
-- rejection on both link tables.
--
-- The notes triggers are AFTER, not BEFORE (unlike the tasks mirrors): any
-- BEFORE UPDATE row trigger on notes — even a column-scoped one that never
-- fires — makes the executor recompute the STORED search_tsv (to_tsvector
-- over up to 200k chars of body) on every UPDATE, including metadata-only
-- ones; with AFTER row triggers the recompute is skipped when title/body are
-- untouched. A RAISE from an AFTER row trigger still aborts the statement
-- with the same SQLSTATE, so the rejection semantics are unchanged.
-- ---------------------------------------------------------------------------

-- notes.project_id immutable (mirror reject_tasks_project_id_change).
CREATE OR REPLACE FUNCTION public.reject_notes_project_id_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION
      'notes.project_id is immutable — cross-team note moves are forbidden'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_project_id_immutable ON public.notes;
CREATE TRIGGER notes_project_id_immutable
  AFTER UPDATE OF project_id ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_notes_project_id_change();

-- notes.created_by immutable once set. visibility and created_by are the
-- notes_member_access predicate inputs; without this, a member can flip a
-- team note to (visibility='private', created_by=self) — WITH CHECK passes on
-- the self-owned private row — stealing it and hiding it from the team.
--
-- The only legitimate created_by change is the `ON DELETE SET NULL` FK nulling
-- it when the author's user row is deleted. That cascade runs in the table
-- owner's context (current_user = the owner role, never app_user), so the
-- `current_user = 'app_user'` clause lets the cascade through while rejecting a
-- member who tries to NULL out (erase) another member's authorship by hand. A
-- bare `NEW.created_by IS NOT NULL` guard would let any member run
-- `UPDATE notes SET created_by = NULL` and wipe a team note's author.
CREATE OR REPLACE FUNCTION public.reject_notes_created_by_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by
     AND (NEW.created_by IS NOT NULL OR current_user = 'app_user') THEN
    RAISE EXCEPTION
      'notes.created_by is immutable — note ownership cannot be reassigned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_created_by_immutable ON public.notes;
CREATE TRIGGER notes_created_by_immutable
  AFTER UPDATE OF created_by ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_notes_created_by_change();

-- notes.updated_by / share_requested_by pinned to the caller. Both are
-- editorial attribution that legitimately changes on edits and share
-- requests, so they are not frozen like created_by; instead any new value an
-- app_user writes must be the caller themselves. NULLing updated_by is
-- reserved to the owner-context ON DELETE SET NULL cascade (same rationale
-- as reject_notes_created_by_change); clearing share_requested_by to NULL is
-- a legitimate app action (a share request being resolved), so it stays
-- open. The whole check is gated on current_user = 'app_user': the FK
-- cascade and service_role run in trusted contexts, and the gate keeps
-- current_app_user_id() (EXECUTE granted to app_user/service_role only) from
-- being called in an owner context that may lack the grant.
CREATE OR REPLACE FUNCTION public.reject_notes_attribution_forgery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'app_user' THEN
    IF NEW.updated_by IS DISTINCT FROM OLD.updated_by
       AND (NEW.updated_by IS NULL
            OR NEW.updated_by IS DISTINCT FROM public.current_app_user_id()) THEN
      RAISE EXCEPTION
        'notes.updated_by may only be set to the caller'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.share_requested_by IS DISTINCT FROM OLD.share_requested_by
       AND NEW.share_requested_by IS NOT NULL
       AND NEW.share_requested_by IS DISTINCT FROM public.current_app_user_id() THEN
      RAISE EXCEPTION
        'notes.share_requested_by may only be set to the caller'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_attribution_pinned ON public.notes;
CREATE TRIGGER notes_attribution_pinned
  AFTER UPDATE OF updated_by, share_requested_by ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_notes_attribution_forgery();

-- note_links endpoints must share a project (mirror reject_task_edges_cross_project).
-- SECURITY INVOKER, unlike reject_task_edges_cross_project: notes have a
-- visibility split tasks don't, so a DEFINER lookup that bypasses notes' RLS
-- would see a same-project PRIVATE note owned by someone else, let the row
-- through here, and only then have it rejected by note_links' RLS WITH CHECK
-- — leaking that private note's existence via the SQLSTATE difference (this
-- trigger's 23514 vs RLS's 42501). Running the lookup as the caller makes an
-- invisible note read back as NULL, identically to a nonexistent one, so
-- both cases collapse into this trigger's own 23514 and RLS is never reached.
CREATE OR REPLACE FUNCTION public.reject_note_links_cross_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_src uuid;
  v_tgt uuid;
BEGIN
  SELECT project_id INTO v_src FROM public.notes WHERE id = NEW.source_note_id;
  SELECT project_id INTO v_tgt FROM public.notes WHERE id = NEW.target_note_id;
  IF v_src IS NULL OR v_tgt IS NULL OR v_src IS DISTINCT FROM v_tgt THEN
    RAISE EXCEPTION 'note_links: invalid endpoint pair'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reject_note_links_cross_project() FROM public;
GRANT EXECUTE ON FUNCTION public.reject_note_links_cross_project() TO app_user;

DROP TRIGGER IF EXISTS note_links_same_project_immutable ON public.note_links;
CREATE TRIGGER note_links_same_project_immutable
  BEFORE INSERT OR UPDATE OF source_note_id, target_note_id ON public.note_links
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_note_links_cross_project();

-- note_task_links pins note.project_id == task.project_id. SECURITY INVOKER
-- for the same reason as reject_note_links_cross_project: a DEFINER lookup
-- would bypass notes' RLS and let a same-project private note pass here,
-- leaking its existence when note_task_links' RLS rejects it afterward with
-- a different SQLSTATE. As the caller, an invisible note reads back NULL
-- just like a nonexistent one, so this trigger's own 23514 covers both.
CREATE OR REPLACE FUNCTION public.reject_note_task_links_cross_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_note uuid;
  v_task uuid;
BEGIN
  SELECT project_id INTO v_note FROM public.notes WHERE id = NEW.note_id;
  SELECT project_id INTO v_task FROM public.tasks WHERE id = NEW.task_id;
  IF v_note IS NULL OR v_task IS NULL OR v_note IS DISTINCT FROM v_task THEN
    RAISE EXCEPTION 'note_task_links: invalid note/task pair'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reject_note_task_links_cross_project() FROM public;
GRANT EXECUTE ON FUNCTION public.reject_note_task_links_cross_project() TO app_user;

DROP TRIGGER IF EXISTS note_task_links_same_project_immutable ON public.note_task_links;
CREATE TRIGGER note_task_links_same_project_immutable
  BEFORE INSERT OR UPDATE OF note_id, task_id ON public.note_task_links
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_note_task_links_cross_project();

-- service_role only. Used by the org-delete hook after the org row is
-- queued for deletion — caller-scoped variants race the cascade.
CREATE OR REPLACE FUNCTION public.find_org_member_user_ids_as_admin(p_org_id uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = piyaz_auth, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT m."userId" FROM piyaz_auth."member" m WHERE m."organizationId" = p_org_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.find_org_member_user_ids_as_admin(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.find_org_member_user_ids_as_admin(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Activity propagation — bump projects.updated_at when tasks/edges change.
--
-- The home grid sorts on projects.updated_at and the conditional-GET
-- validators take MAX(updated_at) across projects + tasks + task_edges.
-- Without these triggers only project-metadata edits (and nothing that
-- happens *inside* a project) move the sort key, so actively worked
-- projects sink below recently renamed ones.
--
-- Statement-level with transition tables: a bulk write touching N tasks
-- bumps each distinct parent project once, not N times. SECURITY DEFINER
-- so the bump skips the projects RLS InitPlan — the firing DML already
-- passed RLS on tasks/task_edges, and the function only widens writes to
-- the parent project's updated_at. GREATEST keeps the bump monotonic:
-- now() is transaction start, so a flow that stamps the project with a
-- fresh client-clock timestamp and then writes tasks in the same
-- transaction (renameCategory, deleteCategory) must not be rewound.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_projects_for_changed_tasks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.projects
  SET updated_at = GREATEST(updated_at, now())
  WHERE id IN (SELECT DISTINCT project_id FROM changed_tasks);
  RETURN NULL;
END;
$$;

-- Fire-time EXECUTE is checked against the firing role (see
-- reject_task_edges_cross_project above). service_role included because
-- the documented bypass sites also write tasks.
REVOKE EXECUTE ON FUNCTION public.touch_projects_for_changed_tasks() FROM public;
GRANT EXECUTE ON FUNCTION public.touch_projects_for_changed_tasks() TO app_user, service_role;

DROP TRIGGER IF EXISTS tasks_touch_project_insert ON public.tasks;
CREATE TRIGGER tasks_touch_project_insert
  AFTER INSERT ON public.tasks
  REFERENCING NEW TABLE AS changed_tasks
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.touch_projects_for_changed_tasks();

DROP TRIGGER IF EXISTS tasks_touch_project_update ON public.tasks;
CREATE TRIGGER tasks_touch_project_update
  AFTER UPDATE ON public.tasks
  REFERENCING NEW TABLE AS changed_tasks
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.touch_projects_for_changed_tasks();

DROP TRIGGER IF EXISTS tasks_touch_project_delete ON public.tasks;
CREATE TRIGGER tasks_touch_project_delete
  AFTER DELETE ON public.tasks
  REFERENCING OLD TABLE AS changed_tasks
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.touch_projects_for_changed_tasks();

-- Edges carry no project_id; resolve through both endpoints so the bump
-- matches the validators' definition of project activity. On task-delete
-- cascades the endpoint task rows are already gone — the subquery yields
-- nothing and the tasks_touch_project_delete trigger owns the bump.
CREATE OR REPLACE FUNCTION public.touch_projects_for_changed_task_edges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.projects
  SET updated_at = GREATEST(updated_at, now())
  WHERE id IN (
    SELECT DISTINCT t.project_id
    FROM public.tasks t
    WHERE t.id IN (
      SELECT source_task_id FROM changed_edges
      UNION
      SELECT target_task_id FROM changed_edges
    )
  );
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.touch_projects_for_changed_task_edges() FROM public;
GRANT EXECUTE ON FUNCTION public.touch_projects_for_changed_task_edges() TO app_user, service_role;

DROP TRIGGER IF EXISTS task_edges_touch_project_insert ON public.task_edges;
CREATE TRIGGER task_edges_touch_project_insert
  AFTER INSERT ON public.task_edges
  REFERENCING NEW TABLE AS changed_edges
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.touch_projects_for_changed_task_edges();

DROP TRIGGER IF EXISTS task_edges_touch_project_update ON public.task_edges;
CREATE TRIGGER task_edges_touch_project_update
  AFTER UPDATE ON public.task_edges
  REFERENCING NEW TABLE AS changed_edges
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.touch_projects_for_changed_task_edges();

DROP TRIGGER IF EXISTS task_edges_touch_project_delete ON public.task_edges;
CREATE TRIGGER task_edges_touch_project_delete
  AFTER DELETE ON public.task_edges
  REFERENCING OLD TABLE AS changed_edges
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.touch_projects_for_changed_task_edges();
