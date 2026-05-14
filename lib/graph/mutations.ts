"use server";

import { getAuthContext } from "@/lib/auth/context";
import {
  updateProject as coreUpdateProject,
  renameProjectIdentifier as coreRenameProjectIdentifier,
  renameCategory as coreRenameCategory,
  deleteCategory as coreDeleteCategory,
} from "@/lib/data/project";
import type { ProjectUpdate } from "@/lib/data/project";
import {
  createTask as coreCreateTask,
  updateTask as coreUpdateTask,
  deleteTask as coreDeleteTask,
  addTaskLink as coreAddTaskLink,
  removeTaskLink as coreRemoveTaskLink,
  updateTaskLink as coreUpdateTaskLink,
} from "@/lib/data/task";
import type { CreateTaskInput, TaskUpdate } from "@/lib/data/task";
import {
  createEdge as coreCreateEdge,
  removeEdge as coreRemoveEdge,
} from "@/lib/data/edge";
import type { Identifier } from "@/lib/graph/identifier";
import type { NewTaskEdge } from "@/lib/db/schema";

export type { CreateProjectInput, ProjectUpdate } from "@/lib/data/project";
export type { CreateTaskInput, TaskUpdate } from "@/lib/data/task";

// Wrappers exist on demand for client-component callers. MCP and route
// handlers import lib/data/* directly with their own ctx.

/**
 * Server action wrapper — update a project's fields.
 * @param projectId - UUID of the project.
 * @param changes - Subset of project fields to update.
 * @returns The updated project row.
 */
export async function updateProject(
  projectId: string,
  changes: ProjectUpdate,
) {
  const ctx = await getAuthContext();
  return coreUpdateProject(ctx, projectId, changes);
}

/**
 * Server action wrapper — rename a project's identifier prefix.
 * @param projectId - UUID of the project.
 * @param identifier - New identifier (already shape-validated).
 * @returns The updated project row.
 */
export async function renameProjectIdentifier(
  projectId: string,
  identifier: Identifier,
) {
  const ctx = await getAuthContext();
  return coreRenameProjectIdentifier(ctx, projectId, identifier);
}

/**
 * Server action wrapper — create a task under a project.
 * @param data - Task fields. sequenceNumber is assigned internally.
 * @returns Task summary with composed taskRef.
 */
export async function createTask(data: CreateTaskInput) {
  const ctx = await getAuthContext();
  return coreCreateTask(ctx, data);
}

/**
 * Server action wrapper — update a task's fields.
 * @param taskId - UUID of the task.
 * @param changes - Partial fields to update.
 * @param overwriteArrays - When true, replace array fields instead of appending.
 * @returns The updated row.
 */
export async function updateTask(
  taskId: string,
  changes: TaskUpdate,
  overwriteArrays = false,
) {
  const ctx = await getAuthContext();
  return coreUpdateTask(ctx, taskId, changes, overwriteArrays);
}

/**
 * Server action wrapper — delete a task and its edges.
 * @param taskId - UUID of the task.
 * @returns Deletion summary.
 */
export async function deleteTask(taskId: string) {
  const ctx = await getAuthContext();
  return coreDeleteTask(ctx, taskId);
}

/**
 * Server action wrapper — create an edge between two tasks.
 * @param data - Edge fields to insert.
 * @returns The created edge.
 */
export async function createEdge(data: Omit<NewTaskEdge, "id">) {
  const ctx = await getAuthContext();
  return coreCreateEdge(ctx, data);
}

/**
 * Server action wrapper — remove an edge by id.
 * @param edgeId - UUID of the edge.
 */
export async function removeEdge(edgeId: string) {
  const ctx = await getAuthContext();
  return coreRemoveEdge(ctx, edgeId);
}

/**
 * Server action wrapper — add a URL to a task's links. The data layer
 * classifies the URL and inserts a `task_links` row; duplicate URLs on
 * the same task return the existing row idempotently.
 * @param taskId - UUID of the task.
 * @param url - URL to attach.
 * @returns The new (or pre-existing) link row.
 */
export async function addTaskLink(taskId: string, url: string) {
  const ctx = await getAuthContext();
  return coreAddTaskLink(ctx, taskId, url);
}

/**
 * Server action wrapper — remove a link by id. Access is checked against
 * the link's parent task; missing link ids surface as authorization
 * failures to avoid cross-team enumeration.
 * @param linkId - UUID of the `task_links` row.
 * @returns Deletion summary with the removed link id.
 */
export async function removeTaskLink(linkId: string) {
  const ctx = await getAuthContext();
  return coreRemoveTaskLink(ctx, linkId);
}

/**
 * Server action wrapper — update a link's URL in place. The data layer
 * re-classifies the URL so `kind` and `label` reflect the new shape;
 * `id`, `createdAt`, and `createdBy` are preserved so the audit trail
 * survives the edit.
 * @param linkId - UUID of the `task_links` row.
 * @param url - New URL.
 * @returns The updated link row.
 */
export async function updateTaskLink(linkId: string, url: string) {
  const ctx = await getAuthContext();
  return coreUpdateTaskLink(ctx, linkId, url);
}

/**
 * Server action wrapper — rename a project category and its task references.
 * @param projectId - UUID of the project.
 * @param oldName - Current category name.
 * @param newName - New category name.
 */
export async function renameCategory(
  projectId: string,
  oldName: string,
  newName: string,
) {
  const ctx = await getAuthContext();
  return coreRenameCategory(ctx, projectId, oldName, newName);
}

/**
 * Server action wrapper — delete a project category and uncategorize its tasks.
 * @param projectId - UUID of the project.
 * @param categoryName - Category to remove.
 */
export async function deleteCategory(projectId: string, categoryName: string) {
  const ctx = await getAuthContext();
  return coreDeleteCategory(ctx, projectId, categoryName);
}
