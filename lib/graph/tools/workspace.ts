/**
 * `piyaz_workspace` handler: caller identity, team memberships, member
 * directory, and project list/create/update plus category-cascade edits.
 * The session-start tool.
 */

import {
  createProject,
  updateProject,
  renameProjectIdentifier,
  renameCategory,
  deleteCategory,
  getProjectCategories,
  listProjectsForMcp,
  listUserTeams,
  type ProjectUpdate,
} from "@/lib/data/project";
import { getWhoami } from "@/lib/data/account";
import { listTeamMembers } from "@/lib/data/membership";
import type { Project } from "@/lib/db/schema";
import { parseIdentifier } from "@/lib/graph/identifier";
import { formatTeamMembers, formatWhoami } from "@/lib/graph/format-responses";
import {
  MultiTeamAmbiguityError,
  NoTeamMembershipError,
  ProjectArchivedError,
  UnknownCategoryError,
} from "@/lib/graph/errors";
import { ForbiddenError } from "@/lib/auth/authorization";
import type { AuthContext } from "@/lib/auth/context";
import type { ProjectStatus } from "@/lib/types";
import {
  ok,
  fail,
  projectStatusTransitionHints,
  requireProjectId,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Backstop row cap for the teams/projects list actions. */
const MAX_LIST_ROWS = 100;

/** Params for piyaz_workspace. */
export type WorkspaceParams = {
  action:
    | "whoami"
    | "teams"
    | "projects"
    | "members"
    | "create"
    | "update"
    | "rename_category"
    | "delete_category";
  project?: string;
  title?: string;
  description?: string;
  status?: "brainstorming" | "decomposing" | "active" | "archived";
  categories?: string[];
  identifier?: string;
  organizationId?: string;
  category?: string;
  newCategory?: string;
};

/**
 * Handle piyaz_workspace actions.
 * @param p - Validated workspace params.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
export async function handleWorkspace(
  p: WorkspaceParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "whoami": {
        const [who, teams] = await Promise.all([
          getWhoami(ctx),
          listUserTeams(ctx),
        ]);
        return ok(formatWhoami(who, teams));
      }
      case "teams": {
        const teams = await listUserTeams(ctx);
        if (teams.length <= MAX_LIST_ROWS) return ok(teams);
        return ok({
          teams: teams.slice(0, MAX_LIST_ROWS),
          _hints: [`Showing ${MAX_LIST_ROWS} of ${teams.length} teams.`],
        });
      }
      case "projects": {
        const projects = await listProjectsForMcp(ctx);
        if (projects.length <= MAX_LIST_ROWS) return ok(projects);
        return ok({
          projects: projects.slice(0, MAX_LIST_ROWS),
          _hints: [
            `Showing ${MAX_LIST_ROWS} of ${projects.length} projects. Address a specific project via piyaz_get project='<identifier>' view='meta', or archive stale projects.`,
          ],
        });
      }
      case "members": {
        let organizationId = p.organizationId;
        if (organizationId === undefined) {
          const teams = await listUserTeams(ctx);
          if (teams.length === 0) throw new NoTeamMembershipError();
          if (teams.length > 1) {
            throw new MultiTeamAmbiguityError(
              teams.map((t) => ({ id: t.id, name: t.name })),
            );
          }
          organizationId = teams[0].id;
        }
        const members = await listTeamMembers(ctx.userId, organizationId);
        if (members.length === 0) {
          throw new ForbiddenError("Forbidden", "team", organizationId);
        }
        const rendered = formatTeamMembers(members);
        return ok(
          rendered.text,
          rendered.truncated ? { truncated: true } : undefined,
        );
      }
      case "rename_category": {
        if (!p.project)
          return fail(
            "project required for rename_category: identifier ('PXD') or UUID.",
          );
        if (!p.category?.trim() || !p.newCategory?.trim())
          return fail(
            "category and newCategory required. rename_category renames the vocabulary entry AND moves every task in it, atomically. See the current vocabulary via piyaz_get project view='meta'.",
          );
        const projectId = await requireProjectId(ctx, p.project);
        const { categories, status, identifier } = await getProjectCategories(
          ctx,
          projectId,
        );
        if (status === "archived") throw new ProjectArchivedError(identifier);
        if (!categories.includes(p.category))
          throw new UnknownCategoryError(p.category, categories);
        if (p.category === p.newCategory)
          return fail(
            "category and newCategory are identical; nothing to rename.",
          );
        if (categories.includes(p.newCategory))
          return fail(
            `newCategory '${p.newCategory}' already exists. To merge, re-categorize the tasks (piyaz_search project='${p.project}' category='${p.category}', then piyaz_edit op='set' field='category' per task) and delete_category the emptied one.`,
          );
        await renameCategory(ctx, projectId, p.category, p.newCategory);
        return ok({
          renamed: { from: p.category, to: p.newCategory },
          categories: categories.map((c) =>
            c === p.category ? p.newCategory : c,
          ),
          _hints: [
            "Every task in the old category was moved in the same transaction. Verify with piyaz_get project view='meta'.",
          ],
        });
      }
      case "delete_category": {
        if (!p.project)
          return fail(
            "project required for delete_category: identifier ('PXD') or UUID.",
          );
        if (!p.category?.trim())
          return fail(
            "category required. delete_category removes the vocabulary entry and uncategorizes its tasks. See the current vocabulary via piyaz_get project view='meta'.",
          );
        const projectId = await requireProjectId(ctx, p.project);
        const { categories, status, identifier } = await getProjectCategories(
          ctx,
          projectId,
        );
        if (status === "archived") throw new ProjectArchivedError(identifier);
        if (!categories.includes(p.category))
          throw new UnknownCategoryError(p.category, categories);
        await deleteCategory(ctx, projectId, p.category);
        return ok({
          deleted: p.category,
          categories: categories.filter((c) => c !== p.category),
          _hints: [
            "Its tasks now carry category=null (the category filter no longer finds them). Re-categorize via piyaz_edit op='set' field='category', or find them in piyaz_get project view='overview'.",
          ],
        });
      }
      case "create": {
        if (!p.title)
          return fail(
            "title required for create. 2-5 words, verb-noun preferred (e.g. 'Track team habits').",
          );
        let parsedIdentifier;
        if (p.identifier !== undefined) {
          const parsed = parseIdentifier(p.identifier);
          if (!parsed.ok) return fail(parsed.error);
          parsedIdentifier = parsed.value;
        }
        const project = await createProject(ctx, {
          title: p.title,
          description: p.description ?? "",
          ...(p.status !== undefined && { status: p.status }),
          categories: p.categories,
          identifier: parsedIdentifier,
          organizationId: p.organizationId,
        });
        const createHints: string[] = [];
        if (p.identifier === undefined) {
          createHints.push(
            `Auto-derived identifier '${project.identifier}' from title. Pass identifier='...' to override (2-12 chars, uppercase alphanumeric, unique per team).`,
          );
        }
        return ok(
          createHints.length > 0
            ? { ...project, _hints: createHints }
            : project,
        );
      }
      case "update": {
        if (!p.project)
          return fail(
            "project required for update: identifier ('PXD') or UUID. Run piyaz_workspace action='projects' to find it.",
          );
        if (
          p.title === undefined &&
          p.description === undefined &&
          p.status === undefined &&
          p.categories === undefined &&
          p.identifier === undefined
        ) {
          return fail(
            "update requires at least one of: title, description, status, categories, identifier.",
          );
        }
        const projectId = await requireProjectId(ctx, p.project);
        const changes: ProjectUpdate = {};
        if (p.title !== undefined) changes.title = p.title;
        if (p.description !== undefined) changes.description = p.description;
        if (p.status !== undefined) changes.status = p.status;
        if (p.categories !== undefined) changes.categories = p.categories;

        const parsed =
          p.identifier !== undefined ? parseIdentifier(p.identifier) : null;
        if (parsed && !parsed.ok) return fail(parsed.error);

        let project: Project | undefined;
        let priorStatus: ProjectStatus | undefined;
        if (Object.keys(changes).length > 0) {
          const { priorStatus: prior, ...updated } = await updateProject(
            ctx,
            projectId,
            changes,
          );
          project = updated;
          priorStatus = prior;
        }
        // The rename runs last: the two writes are separate transactions,
        // and a failure between them must not leave the taskRef-cascading
        // rename committed while the field update never happened.
        if (parsed?.ok) {
          project = await renameProjectIdentifier(ctx, projectId, parsed.value);
        }

        const updateHints: string[] = [];
        if (p.identifier !== undefined) {
          updateHints.push(
            `Renamed all task refs to '${p.identifier}-N'. External references (GitHub PRs, docs, commit messages) to the old prefix no longer resolve.`,
          );
        }
        if (
          p.status !== undefined &&
          priorStatus !== undefined &&
          priorStatus !== p.status
        ) {
          updateHints.push(
            ...projectStatusTransitionHints(priorStatus, p.status),
          );
        }
        if (p.status === undefined && project?.status === "archived") {
          updateHints.push(
            `Project '${p.project}' is archived (task surface read-only); this metadata update applied, but task/edge writes will fail. To resume work: piyaz_workspace action='update' project='${p.project}' status='active'.`,
          );
        }
        return ok(
          updateHints.length > 0
            ? { ...project, _hints: updateHints }
            : project,
        );
      }
    }
  } catch (e) {
    return translateError(e);
  }
}
