/**
 * `piyaz_workspace` handler: caller identity, team memberships, and project
 * list/create/update. The session-start tool.
 */

import {
  createProject,
  updateProject,
  renameProjectIdentifier,
  listProjectsForMcp,
  listUserTeams,
  type ProjectUpdate,
} from "@/lib/data/project";
import { getWhoami } from "@/lib/data/account";
import type { Project } from "@/lib/db/schema";
import { parseIdentifier } from "@/lib/graph/identifier";
import { formatWhoami } from "@/lib/graph/format-responses";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  requireProjectId,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_workspace. */
export type WorkspaceParams = {
  action: "whoami" | "teams" | "projects" | "create" | "update";
  project?: string;
  title?: string;
  description?: string;
  status?: "brainstorming" | "decomposing" | "active" | "archived";
  categories?: string[];
  identifier?: string;
  organizationId?: string;
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
      case "teams":
        return ok(await listUserTeams(ctx));
      case "projects":
        return ok(await listProjectsForMcp(ctx));
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
            "project required for update: identifier ('PYZ') or UUID. Run piyaz_workspace action='projects' to find it.",
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
        if (Object.keys(changes).length > 0) {
          project = await updateProject(ctx, projectId, changes);
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
