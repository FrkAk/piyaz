'use server';

import { z } from 'zod/v4';
import { parseIdentifier } from '@/lib/graph/identifier';
import {
  deleteCategory,
  renameCategory,
  renameProjectIdentifier,
  updateProject,
  type ProjectUpdate,
} from '@/lib/graph/mutations';
import { deleteProject as deleteProjectCore } from '@/lib/data/project';
import { ProjectNotFoundError } from '@/lib/graph/errors';
import { getAuthContext } from '@/lib/auth/context';
import {
  ForbiddenError,
  InsufficientRoleError,
} from '@/lib/auth/authorization';

/** Statuses the web app is allowed to set. Coding agents handle brainstorming/decomposing via MCP. */
const WEB_ALLOWED_STATUSES = ['active', 'archived'] as const;
export type WebAllowedStatus = (typeof WEB_ALLOWED_STATUSES)[number];
const webStatusSchema = z.enum(WEB_ALLOWED_STATUSES);

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 10_000;
const CATEGORY_NAME_MAX = 64;
const CATEGORIES_MAX = 50;

const uuidSchema = z.uuid();
const projectIdSchema = uuidSchema;

const categoryNameSchema = z
  .string()
  .trim()
  .min(1, 'Category name is required')
  .max(CATEGORY_NAME_MAX, `Category name must be ${CATEGORY_NAME_MAX} characters or less`);

const projectSettingsChangesSchema = z.strictObject({
  title: z.string().trim().min(1).max(TITLE_MAX).optional(),
  description: z.string().max(DESCRIPTION_MAX).optional(),
  identifier: z.string().optional(),
  categories: z.array(categoryNameSchema).max(CATEGORIES_MAX).optional(),
});

/** Fields the settings modal can update. All optional. */
export type ProjectSettingsChanges = z.infer<typeof projectSettingsChangesSchema>;

/** Result of a project settings update action. */
export type ProjectSettingsResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'unauthorized'
        | 'forbidden'
        | 'invalid_input'
        | 'invalid_identifier'
        | 'identifier_conflict'
        | 'not_found'
        | 'unknown';
      message: string;
    };

/** Result of a project category update action. */
export type ProjectCategoryResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'unauthorized'
        | 'forbidden'
        | 'invalid_input'
        | 'not_found'
        | 'unknown';
      message: string;
    };

/** Result of a project status update action. */
export type ProjectStatusResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'unauthorized'
        | 'forbidden'
        | 'invalid_input'
        | 'not_found'
        | 'unknown';
      message: string;
    };

/** Result of a project delete action. */
export type ProjectDeleteResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'unauthorized'
        | 'forbidden'
        | 'invalid_input'
        | 'not_found'
        | 'unknown';
      message: string;
    };

const UNAUTHORIZED_MESSAGE = 'You must be signed in to perform this action.';
const FORBIDDEN_MESSAGE = "You don't have access to this project.";

/**
 * Resolve auth context and translate auth failures into typed error results.
 * @returns The resolved AuthContext, or a typed `unauthorized` failure.
 */
async function resolveAuthOrFail():
  Promise<{ ok: true; ctx: Awaited<ReturnType<typeof getAuthContext>> }
    | { ok: false; code: 'unauthorized'; message: string }> {
  try {
    const ctx = await getAuthContext();
    return { ok: true, ctx };
  } catch {
    return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE };
  }
}

/**
 * Delete a project (cascades to tasks and edges via DB foreign keys).
 * Surface a typed `forbidden` result for non-admins so the UI can render
 * actionable copy without throwing through the client component.
 * @param projectId - UUID of the project to delete.
 * @returns Discriminated result.
 */
export async function deleteProjectAction(
  projectId: string,
): Promise<ProjectDeleteResult> {
  const auth = await resolveAuthOrFail();
  if (!auth.ok) return auth;

  const idParsed = projectIdSchema.safeParse(projectId);
  if (!idParsed.success) {
    return { ok: false, code: 'invalid_input', message: 'Invalid project id.' };
  }

  try {
    await deleteProjectCore(auth.ctx, idParsed.data);
    return { ok: true };
  } catch (err) {
    if (err instanceof InsufficientRoleError) {
      return {
        ok: false,
        code: 'forbidden',
        message: 'Only team admins can delete projects.',
      };
    }
    if (err instanceof ForbiddenError) {
      return { ok: false, code: 'not_found', message: 'Project not found.' };
    }
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, code: 'not_found', message: 'Project not found.' };
    }
    console.error('deleteProjectAction failed', { projectId: idParsed.data, err });
    return {
      ok: false,
      code: 'unknown',
      message: 'Something went wrong. Please try again.',
    };
  }
}

/**
 * Update a project's status. Web is restricted to `active` ↔ `archived`.
 * @param projectId - UUID of the project.
 * @param status - New status (`active` or `archived` only).
 * @returns Discriminated result.
 */
export async function updateProjectStatus(
  projectId: string,
  status: WebAllowedStatus,
): Promise<ProjectStatusResult> {
  const auth = await resolveAuthOrFail();
  if (!auth.ok) return auth;

  const idParsed = projectIdSchema.safeParse(projectId);
  const statusParsed = webStatusSchema.safeParse(status);
  if (!idParsed.success || !statusParsed.success) {
    return { ok: false, code: 'invalid_input', message: 'Invalid project id or status.' };
  }

  try {
    const updated = await updateProject(idParsed.data, { status: statusParsed.data });
    if (!updated) {
      return { ok: false, code: 'not_found', message: 'Project not found.' };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: 'forbidden', message: FORBIDDEN_MESSAGE };
    }
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, code: 'not_found', message: 'Project not found.' };
    }
    console.error('updateProjectStatus failed', { projectId: idParsed.data, err });
    return { ok: false, code: 'unknown', message: 'Something went wrong. Please try again.' };
  }
}

/**
 * Update project settings with identifier validation and conflict mapping.
 * @param projectId - UUID of the project to update.
 * @param changes - Partial fields to persist.
 * @returns Discriminated result.
 */
export async function updateProjectSettings(
  projectId: string,
  changes: ProjectSettingsChanges,
): Promise<ProjectSettingsResult> {
  const auth = await resolveAuthOrFail();
  if (!auth.ok) return auth;

  const idParsed = projectIdSchema.safeParse(projectId);
  if (!idParsed.success) {
    return { ok: false, code: 'invalid_input', message: 'Invalid project id.' };
  }
  const changesParsed = projectSettingsChangesSchema.safeParse(changes);
  if (!changesParsed.success) {
    return {
      ok: false,
      code: 'invalid_input',
      message: changesParsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }
  const validChanges = changesParsed.data;

  const update: ProjectUpdate = {};
  if (validChanges.title !== undefined) update.title = validChanges.title;
  if (validChanges.description !== undefined) update.description = validChanges.description;
  if (validChanges.categories !== undefined) update.categories = validChanges.categories;

  try {
    if (validChanges.identifier !== undefined) {
      const parsed = parseIdentifier(validChanges.identifier);
      if (!parsed.ok) {
        return { ok: false, code: 'invalid_identifier', message: parsed.error };
      }
      await renameProjectIdentifier(idParsed.data, parsed.value);
    }
    if (Object.keys(update).length > 0) {
      const result = await updateProject(idParsed.data, update);
      if (!result) {
        return { ok: false, code: 'not_found', message: 'Project not found.' };
      }
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof InsufficientRoleError) {
      return {
        ok: false,
        code: 'forbidden',
        message: 'Only team admins can rename project identifiers.',
      };
    }
    if (err instanceof ForbiddenError) {
      return { ok: false, code: 'forbidden', message: FORBIDDEN_MESSAGE };
    }
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, code: 'not_found', message: 'Project not found.' };
    }
    const code = (err as { code?: string } | null)?.code;
    if (code === '23505') {
      return {
        ok: false,
        code: 'identifier_conflict',
        message: 'That identifier is already in use by another project',
      };
    }
    console.error('updateProjectSettings failed', { projectId: idParsed.data, err });
    return {
      ok: false,
      code: 'unknown',
      message: 'Something went wrong. Please try again.',
    };
  }
}

/**
 * Rename a category on a project, propagating to associated tasks.
 * @param projectId - UUID of the project.
 * @param oldName - Existing category name.
 * @param newName - Replacement category name.
 * @returns Discriminated result.
 */
export async function renameProjectCategory(
  projectId: string,
  oldName: string,
  newName: string,
): Promise<ProjectCategoryResult> {
  const auth = await resolveAuthOrFail();
  if (!auth.ok) return auth;

  const idParsed = projectIdSchema.safeParse(projectId);
  const oldParsed = categoryNameSchema.safeParse(oldName);
  const newParsed = categoryNameSchema.safeParse(newName);
  if (!idParsed.success || !oldParsed.success || !newParsed.success) {
    return { ok: false, code: 'invalid_input', message: 'Invalid project id or category name.' };
  }

  try {
    await renameCategory(idParsed.data, oldParsed.data, newParsed.data);
    return { ok: true };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: 'forbidden', message: FORBIDDEN_MESSAGE };
    }
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, code: 'not_found', message: 'Project not found.' };
    }
    console.error('renameProjectCategory failed', { projectId: idParsed.data, err });
    return { ok: false, code: 'unknown', message: 'Failed to rename category' };
  }
}

/**
 * Delete a category from a project, propagating to associated tasks.
 * @param projectId - UUID of the project.
 * @param categoryName - Category to remove.
 * @returns Discriminated result.
 */
export async function deleteProjectCategory(
  projectId: string,
  categoryName: string,
): Promise<ProjectCategoryResult> {
  const auth = await resolveAuthOrFail();
  if (!auth.ok) return auth;

  const idParsed = projectIdSchema.safeParse(projectId);
  const nameParsed = categoryNameSchema.safeParse(categoryName);
  if (!idParsed.success || !nameParsed.success) {
    return { ok: false, code: 'invalid_input', message: 'Invalid project id or category name.' };
  }

  try {
    await deleteCategory(idParsed.data, nameParsed.data);
    return { ok: true };
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, code: 'forbidden', message: FORBIDDEN_MESSAGE };
    }
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, code: 'not_found', message: 'Project not found.' };
    }
    console.error('deleteProjectCategory failed', { projectId: idParsed.data, err });
    return { ok: false, code: 'unknown', message: 'Failed to remove category' };
  }
}
