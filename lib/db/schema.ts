import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  unique,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organization, user } from "@/lib/db/auth-schema";
import type {
  ProjectStatus,
  TaskStatus,
  EdgeType,
  Decision,
  HistoryEntry,
  AcceptanceCriterion,
  Priority,
  Estimate,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    identifier: text("identifier").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<ProjectStatus>().notNull().default("brainstorming"),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    history: jsonb("history").$type<HistoryEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("projects_organization_id_idx").on(t.organizationId),
    unique("projects_org_identifier_unique").on(t.organizationId, t.identifier),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<TaskStatus>().notNull().default("draft"),
    order: integer("order").notNull().default(0),
    category: text("category"),
    acceptanceCriteria: jsonb("acceptance_criteria")
      .$type<AcceptanceCriterion[]>()
      .notNull()
      .default([]),
    decisions: jsonb("decisions").$type<Decision[]>().notNull().default([]),
    implementationPlan: text("implementation_plan"),
    executionRecord: text("execution_record"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    priority: text("priority").$type<Priority>(),
    estimate: integer("estimate").$type<Estimate>(),
    files: jsonb("files").$type<string[]>().notNull().default([]),
    history: jsonb("history").$type<HistoryEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tasks_project_id_idx").on(t.projectId),
    unique("tasks_project_sequence_unique").on(t.projectId, t.sequenceNumber),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// ---------------------------------------------------------------------------
// Task Edges
// ---------------------------------------------------------------------------

export const taskEdges = pgTable(
  "task_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceTaskId: uuid("source_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    targetTaskId: uuid("target_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    edgeType: text("edge_type").$type<EdgeType>().notNull(),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("task_edges_source_idx").on(t.sourceTaskId),
    index("task_edges_target_idx").on(t.targetTaskId),
    uniqueIndex("task_edges_unique_idx").on(t.sourceTaskId, t.targetTaskId, t.edgeType),
  ],
);

export type TaskEdge = typeof taskEdges.$inferSelect;
export type NewTaskEdge = typeof taskEdges.$inferInsert;

// ---------------------------------------------------------------------------
// Task Assignees (junction table; many-to-many tasks ↔ users)
// ---------------------------------------------------------------------------

export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("task_assignees_user_id_idx").on(t.userId),
  ],
);

export type TaskAssignee = typeof taskAssignees.$inferSelect;
export type NewTaskAssignee = typeof taskAssignees.$inferInsert;

// ---------------------------------------------------------------------------
// Task Links (URLs attached to a task: PRs, issues, commits, docs, etc.)
// ---------------------------------------------------------------------------

export const taskLinks = pgTable(
  "task_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("task_links_task_id_idx").on(t.taskId),
    unique("task_links_task_url_unique").on(t.taskId, t.url),
  ],
);

export type TaskLink = typeof taskLinks.$inferSelect;
export type NewTaskLink = typeof taskLinks.$inferInsert;

// ---------------------------------------------------------------------------
// Team Invite Codes (separate file, re-exported here for drizzle-kit)
// ---------------------------------------------------------------------------

export * from "./team-schema";
