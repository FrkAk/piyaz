import { sql, type SQL } from "drizzle-orm";
import { type ReadConn } from "@/lib/db/raw";
import { TERMINAL_STATUSES } from "@/lib/types";

/**
 * Raw row shape returned by {@link taskFullStmt}. Snake-case keys mirror
 * the underlying columns; the caller maps to the camelCase `TaskFull`
 * shape and narrows the `source` union on `decisions`.
 */
export type TaskFullRawRow = {
  id: string;
  project_id: string;
  title: string;
  sequence_number: number;
  description: string;
  status: string;
  order: number;
  category: string | null;
  implementation_plan: string | null;
  execution_record: string | null;
  tags: string[];
  priority: string | null;
  estimate: number | null;
  files: string[];
  created_at: string | Date;
  updated_at: string | Date;
  project_identifier: string;
  assignees: { userId: string; name: string; email: string }[] | null;
  acceptance_criteria: { id: string; text: string; checked: boolean }[] | null;
  decisions:
    | { id: string; text: string; source: string; date: string }[]
    | null;
  links:
    | {
        id: string;
        kind: string;
        url: string;
        label: string | null;
        createdAt: string;
      }[]
    | null;
};

/**
 * Context depth identifying which task-row columns and child aggregates a
 * single MCP context builder reads. Drives {@link taskForDepthStmt} so each
 * depth pays egress only for the columns its formatter renders.
 */
export type TaskFetchDepth =
  | "summary"
  | "working"
  | "planning"
  | "agent"
  | "review"
  | "record";

/**
 * Per-depth projection plan. Each flag gates one droppable `tasks` column or
 * child aggregate; omitted columns fall back to a type-stable empty literal in
 * {@link taskForDepthStmt} so the {@link TaskFullRawRow} shape never changes.
 * Columns every depth renders (id, title, description, status, priority,
 * estimate, ...) are always selected and carry no flag.
 */
type DepthProjection = {
  tags: boolean;
  category: boolean;
  /**
   * `true` always selects the plan; `"active-only"` selects it only for
   * non-terminal rows (`NULL` for done/cancelled) so a single fetch serves
   * both the agent bundle (renders the plan) and the record fallback for
   * terminal tasks (never reads it) without egressing the plan twice over.
   */
  implementationPlan: boolean | "active-only";
  executionRecord: boolean;
  files: boolean;
  assignees: boolean;
  acceptanceCriteria: boolean;
  decisions: boolean;
  links: boolean;
};

/**
 * The exact column set each depth's formatter reads. `files` is omitted at
 * every depth (no formatter reads it — bundles point at the PR diff instead
 * of recorded file lists). `category` is selected at every depth: each
 * bundle header renders it. `implementationPlan` is true for `summary`
 * because `buildSummaryContext` reads its presence (`hasImplementationPlan`)
 * even though it never renders the plan text; `agent` selects it
 * `"active-only"` because terminal tasks dispatch to the record bundle,
 * which never reads the plan — the conditional keeps the dominant active
 * path one fetch while sparing terminal rows the egress of the (often
 * largest) column. `planning` and `agent` select `executionRecord` so
 * work-in-progress renders as "work so far" before `in_review`. `record`
 * serves the retrospective bundle for done/cancelled tasks: it keeps
 * executionRecord, links, decisions, and criteria, and drops
 * `implementationPlan` because the record bundle never renders it. `agent`
 * selects assignees so the implementer sees ownership.
 *
 * Each depth is fetched independently by its own resolver (there is no
 * shared superset fetch). Exported so the projection test can pin the
 * per-depth flags.
 */
export const DEPTH_PROJECTIONS: Record<TaskFetchDepth, DepthProjection> = {
  summary: {
    tags: false,
    category: true,
    implementationPlan: true,
    executionRecord: false,
    files: false,
    assignees: true,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  working: {
    tags: true,
    category: true,
    implementationPlan: false,
    executionRecord: false,
    files: false,
    assignees: true,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  planning: {
    tags: true,
    category: true,
    implementationPlan: true,
    executionRecord: true,
    files: false,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  agent: {
    tags: true,
    category: true,
    implementationPlan: "active-only",
    executionRecord: true,
    files: false,
    assignees: true,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  review: {
    tags: true,
    category: true,
    implementationPlan: true,
    executionRecord: true,
    files: false,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  record: {
    tags: true,
    category: true,
    implementationPlan: false,
    executionRecord: true,
    files: false,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
};

/** Correlated assignee aggregate, identical to {@link taskFullStmt}. */
const ASSIGNEES_AGG = sql`(SELECT json_agg(json_build_object('userId', a.user_id, 'name', a.name, 'email', a.email) ORDER BY a.name)
         FROM public.task_assignees_visible(t.id) a)`;

/** Correlated acceptance-criteria aggregate, identical to {@link taskFullStmt}. */
const CRITERIA_AGG = sql`(SELECT json_agg(json_build_object('id', c.id, 'text', c.text, 'checked', c.checked) ORDER BY c.position, c.id)
         FROM task_acceptance_criteria c
         WHERE c.task_id = t.id)`;

/** Correlated decisions aggregate, identical to {@link taskFullStmt}. */
const DECISIONS_AGG = sql`(SELECT json_agg(json_build_object('id', d.id, 'text', d.text, 'source', d.source, 'date', d.decision_date) ORDER BY d.position, d.id)
         FROM task_decisions d
         WHERE d.task_id = t.id)`;

/** Correlated links aggregate, identical to {@link taskFullStmt}. */
const LINKS_AGG = sql`(SELECT json_agg(json_build_object('id', l.id, 'kind', l.kind, 'url', l.url, 'label', l.label, 'createdAt', l.created_at) ORDER BY l.created_at)
         FROM task_links l
         WHERE l.task_id = t.id)`;

/**
 * Select a `tasks` column when the depth reads it, else a typed `NULL`
 * literal aliased to the same name so {@link TaskFullRawRow} stays stable.
 *
 * @param keep - Whether the depth reads the column.
 * @param column - Bare `tasks` column name (already quoted as `t.<col>`).
 * @param alias - Output column alias.
 * @param nullCast - Postgres cast applied to the `NULL` fallback. Restricted
 *   to known cast literals because the value reaches `sql.raw`.
 * @returns SQL fragment for the SELECT list.
 */
function depthColumn(
  keep: boolean,
  column: SQL,
  alias: string,
  nullCast: "text" | "jsonb" | "integer",
): SQL {
  const aliasId = sql.identifier(alias);
  return keep
    ? sql`${column} AS ${aliasId}`
    : sql`NULL::${sql.raw(nullCast)} AS ${aliasId}`;
}

/**
 * Select the `implementation_plan` column per the depth's plan flag:
 * always, never, or only for non-terminal rows (`NULL` when the task is
 * done/cancelled, mirroring the `record` projection those rows render as).
 *
 * @param keep - The depth's `implementationPlan` projection flag.
 * @returns SQL fragment for the SELECT list.
 */
function planColumn(keep: boolean | "active-only"): SQL {
  if (keep !== "active-only") {
    return depthColumn(
      keep,
      sql`t.implementation_plan`,
      "implementation_plan",
      "text",
    );
  }
  const terminal = sql.join(
    TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`CASE WHEN t.status IN (${terminal}) THEN NULL ELSE t.implementation_plan END AS implementation_plan`;
}

/**
 * Select a child aggregate when the depth reads it, else a `NULL` literal so
 * the caller's `?? []` fallback yields the empty projection.
 *
 * @param keep - Whether the depth reads the aggregate.
 * @param agg - Correlated aggregate subquery.
 * @param alias - Output column alias.
 * @returns SQL fragment for the SELECT list.
 */
function depthAggregate(keep: boolean, agg: SQL, alias: string): SQL {
  const aliasId = sql.identifier(alias);
  return keep ? sql`${agg} AS ${aliasId}` : sql`NULL AS ${aliasId}`;
}

/**
 * Build the depth-projected task-row SQL shared by the interactive and
 * batch read paths. Columns this depth omits are returned as type-stable
 * `NULL` literals so the {@link TaskFullRawRow} shape is identical across
 * depths.
 *
 * @param taskId - UUID of the task.
 * @param depth - Context depth selecting the column projection.
 * @returns Parameterized SQL fragment.
 */
function taskForDepthSql(taskId: string, depth: TaskFetchDepth): SQL {
  const p = DEPTH_PROJECTIONS[depth];
  return sql`
      SELECT
        t.id,
        t.project_id,
        t.title,
        t.sequence_number,
        t.description,
        t.status,
        t."order",
        ${depthColumn(p.category, sql`t.category`, "category", "text")},
        ${planColumn(p.implementationPlan)},
        ${depthColumn(p.executionRecord, sql`t.execution_record`, "execution_record", "text")},
        ${depthColumn(p.tags, sql`t.tags`, "tags", "jsonb")},
        t.priority,
        t.estimate,
        ${depthColumn(p.files, sql`t.files`, "files", "jsonb")},
        t.created_at,
        t.updated_at,
        p.identifier AS project_identifier,
        ${depthAggregate(p.assignees, ASSIGNEES_AGG, "assignees")},
        ${depthAggregate(p.acceptanceCriteria, CRITERIA_AGG, "acceptance_criteria")},
        ${depthAggregate(p.decisions, DECISIONS_AGG, "decisions")},
        ${depthAggregate(p.links, LINKS_AGG, "links")}
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${taskId}
    `;
}

/**
 * The depth-projected task row as a lazy batch statement for the
 * `withUserContextRead` path. Same UNCHECKED contract: batch a
 * `taskAccessGateStmt` alongside and evaluate the gate first. Normalize
 * the batch result with `normalizeExecuteResult<TaskFullRawRow>`.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @param depth - Context depth selecting the column projection.
 * @returns Lazy raw statement yielding zero or one rows.
 */
export function taskForDepthStmt(
  read: ReadConn,
  taskId: string,
  depth: TaskFetchDepth,
) {
  return read.execute(taskForDepthSql(taskId, depth));
}

/**
 * Build the full-task projection SQL shared by the interactive and batch
 * read paths. Joins `tasks` to `projects` and folds `task_assignees`,
 * `task_acceptance_criteria`, `task_decisions`, and `task_links` into
 * JSON-aggregated subqueries.
 *
 * @param taskId - UUID of the task.
 * @returns Parameterized SQL fragment.
 */
function taskFullSql(taskId: string): SQL {
  return sql`
      SELECT
        t.id,
        t.project_id,
        t.title,
        t.sequence_number,
        t.description,
        t.status,
        t."order",
        t.category,
        t.implementation_plan,
        t.execution_record,
        t.tags,
        t.priority,
        t.estimate,
        t.files,
        t.created_at,
        t.updated_at,
        p.identifier AS project_identifier,
        (SELECT json_agg(json_build_object('userId', a.user_id, 'name', a.name, 'email', a.email) ORDER BY a.name)
         FROM public.task_assignees_visible(t.id) a) AS assignees,
        (SELECT json_agg(json_build_object('id', c.id, 'text', c.text, 'checked', c.checked) ORDER BY c.position, c.id)
         FROM task_acceptance_criteria c
         WHERE c.task_id = t.id) AS acceptance_criteria,
        (SELECT json_agg(json_build_object('id', d.id, 'text', d.text, 'source', d.source, 'date', d.decision_date) ORDER BY d.position, d.id)
         FROM task_decisions d
         WHERE d.task_id = t.id) AS decisions,
        (SELECT json_agg(json_build_object('id', l.id, 'kind', l.kind, 'url', l.url, 'label', l.label, 'createdAt', l.created_at) ORDER BY l.created_at)
         FROM task_links l
         WHERE l.task_id = t.id) AS links
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${taskId}
    `;
}

/**
 * The full-task projection as a lazy batch statement. Same UNCHECKED contract:
 * batch a `taskAccessGateStmt` alongside and evaluate the gate first.
 * Normalize the batch result with `normalizeExecuteResult<TaskFullRawRow>`.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @returns Lazy raw statement yielding zero or one rows.
 */
export function taskFullStmt(read: ReadConn, taskId: string) {
  return read.execute(taskFullSql(taskId));
}

/** Every task field addressable by the raw single-field read path. */
export const TASK_FIELD_NAMES = [
  "title",
  "description",
  "status",
  "category",
  "priority",
  "estimate",
  "tags",
  "files",
  "implementationPlan",
  "executionRecord",
  "acceptanceCriteria",
  "decisions",
  "links",
  "assignees",
] as const;

/** One addressable task field name. */
export type TaskFieldName = (typeof TASK_FIELD_NAMES)[number];

/**
 * Raw row returned by {@link taskFieldsStmt}. Identity columns (id, ref
 * parts, `updated_at` for optimistic-concurrency reads) are always selected;
 * every other column is `NULL` unless its field was requested.
 */
export type TaskFieldsRawRow = Pick<
  TaskFullRawRow,
  "id" | "project_id" | "sequence_number" | "project_identifier" | "updated_at"
> &
  Partial<
    Omit<
      TaskFullRawRow,
      | "id"
      | "project_id"
      | "sequence_number"
      | "project_identifier"
      | "updated_at"
      | "order"
      | "created_at"
    >
  >;

/**
 * Field-projected task row for the MCP `fields=[...]` read path: exactly the
 * requested columns are egressed (others return as typed `NULL` literals),
 * so a single-field read pays for one column. Identity columns and
 * `updated_at` always ride along for ref composition and `ifUpdatedAt`
 * preconditions. Same UNCHECKED contract as {@link taskForDepthStmt}: batch
 * a `taskAccessGateStmt` alongside and evaluate the gate first.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @param fields - Requested field names; unknown names never reach here
 *   (the schema layer validates against {@link TASK_FIELD_NAMES}).
 * @returns Lazy raw statement yielding zero or one rows.
 */
export function taskFieldsStmt(
  read: ReadConn,
  taskId: string,
  fields: readonly TaskFieldName[],
) {
  const has = (f: TaskFieldName): boolean => fields.includes(f);
  return read.execute(sql`
      SELECT
        t.id,
        t.project_id,
        t.sequence_number,
        t.updated_at,
        p.identifier AS project_identifier,
        ${depthColumn(has("title"), sql`t.title`, "title", "text")},
        ${depthColumn(has("description"), sql`t.description`, "description", "text")},
        ${depthColumn(has("status"), sql`t.status`, "status", "text")},
        ${depthColumn(has("category"), sql`t.category`, "category", "text")},
        ${depthColumn(has("priority"), sql`t.priority`, "priority", "text")},
        ${depthColumn(has("estimate"), sql`t.estimate`, "estimate", "integer")},
        ${depthColumn(has("tags"), sql`t.tags`, "tags", "jsonb")},
        ${depthColumn(has("files"), sql`t.files`, "files", "jsonb")},
        ${depthColumn(has("implementationPlan"), sql`t.implementation_plan`, "implementation_plan", "text")},
        ${depthColumn(has("executionRecord"), sql`t.execution_record`, "execution_record", "text")},
        ${depthAggregate(has("acceptanceCriteria"), CRITERIA_AGG, "acceptance_criteria")},
        ${depthAggregate(has("decisions"), DECISIONS_AGG, "decisions")},
        ${depthAggregate(has("links"), LINKS_AGG, "links")},
        ${depthAggregate(has("assignees"), ASSIGNEES_AGG, "assignees")}
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${taskId}
    `);
}
