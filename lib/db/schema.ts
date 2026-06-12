import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
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
  Priority,
  Estimate,
  ActivityEventType,
  ActivitySource,
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
    status: text("status")
      .$type<ProjectStatus>()
      .notNull()
      .default("brainstorming"),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    history: jsonb("history").$type<HistoryEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("projects_organization_id_idx").on(t.organizationId),
    unique("projects_org_identifier_unique").on(t.organizationId, t.identifier),
  ],
).enableRLS();

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
    implementationPlan: text("implementation_plan"),
    executionRecord: text("execution_record"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    priority: text("priority").$type<Priority>(),
    estimate: integer("estimate").$type<Estimate>(),
    files: jsonb("files").$type<string[]>().notNull().default([]),
    history: jsonb("history").$type<HistoryEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tasks_project_id_idx").on(t.projectId),
    unique("tasks_project_sequence_unique").on(t.projectId, t.sequenceNumber),
  ],
).enableRLS();

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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("task_edges_source_idx").on(t.sourceTaskId),
    index("task_edges_target_idx").on(t.targetTaskId),
    uniqueIndex("task_edges_unique_idx").on(
      t.sourceTaskId,
      t.targetTaskId,
      t.edgeType,
    ),
  ],
).enableRLS();

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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("task_assignees_user_id_idx").on(t.userId),
  ],
).enableRLS();

export type TaskAssignee = typeof taskAssignees.$inferSelect;
export type NewTaskAssignee = typeof taskAssignees.$inferInsert;

// ---------------------------------------------------------------------------
// Task Acceptance Criteria (replaces tasks.acceptance_criteria JSONB)
// ---------------------------------------------------------------------------

export const taskAcceptanceCriteria = pgTable(
  "task_acceptance_criteria",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    checked: boolean("checked").notNull().default(false),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("task_acceptance_criteria_task_id_position_idx").on(
      t.taskId,
      t.position,
    ),
    unique("task_acceptance_criteria_task_id_text_unique").on(t.taskId, t.text),
  ],
).enableRLS();

export type TaskAcceptanceCriterion =
  typeof taskAcceptanceCriteria.$inferSelect;
export type NewTaskAcceptanceCriterion =
  typeof taskAcceptanceCriteria.$inferInsert;

// ---------------------------------------------------------------------------
// Task Decisions (replaces tasks.decisions JSONB)
// ---------------------------------------------------------------------------

export const taskDecisions = pgTable(
  "task_decisions",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    source: text("source").$type<Decision["source"]>().notNull(),
    decisionDate: text("decision_date").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("task_decisions_task_id_position_idx").on(t.taskId, t.position),
    unique("task_decisions_task_id_text_unique").on(t.taskId, t.text),
  ],
).enableRLS();

export type TaskDecision = typeof taskDecisions.$inferSelect;
export type NewTaskDecision = typeof taskDecisions.$inferInsert;

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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("task_links_task_id_idx").on(t.taskId),
    unique("task_links_task_url_unique").on(t.taskId, t.url),
  ],
).enableRLS();

export type TaskLink = typeof taskLinks.$inferSelect;
export type NewTaskLink = typeof taskLinks.$inferInsert;

// ---------------------------------------------------------------------------
// Activity Events (append-only audit log for tasks + projects)
// ---------------------------------------------------------------------------

export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").$type<ActivityEventType>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorUserId: uuid("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source").$type<ActivitySource>().notNull(),
    actorClientId: text("actor_client_id"),
    summary: text("summary").notNull(),
    targetRef: text("target_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("activity_events_task_id_created_idx").on(t.taskId, t.createdAt),
    index("activity_events_project_id_created_idx").on(t.projectId, t.createdAt),
    index("activity_events_actor_user_id_idx").on(t.actorUserId),
  ],
).enableRLS();

export type ActivityEventRow = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;

// ---------------------------------------------------------------------------
// Team Invite Codes (separate file, re-exported here for drizzle-kit)
// ---------------------------------------------------------------------------

export * from "./team-schema";
