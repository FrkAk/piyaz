import { sql, type SQL } from "drizzle-orm";
import { executeRaw, type Conn } from "@/lib/db/raw";

/**
 * Raw row shape returned by {@link fetchTaskFull}. Snake-case keys mirror
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
  history: unknown[];
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
 * single MCP context builder reads. Drives {@link fetchTaskForDepth} so each
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
 * {@link fetchTaskForDepth} so the {@link TaskFullRawRow} shape never changes.
 * Columns every depth renders (id, title, description, status, priority,
 * estimate, ...) are always selected and carry no flag.
 */
type DepthProjection = {
  tags: boolean;
  implementationPlan: boolean;
  executionRecord: boolean;
  files: boolean;
  assignees: boolean;
  acceptanceCriteria: boolean;
  decisions: boolean;
  links: boolean;
};

/**
 * The exact column set each depth's formatter reads. `category` and `history`
 * are omitted at every depth (no formatter reads them). `implementationPlan`
 * is true for `summary` because `buildSummaryContext` reads its presence
 * (`hasImplementationPlan`) even though it never renders the plan text.
 * `record` serves the retrospective bundle for done/cancelled tasks: it keeps
 * executionRecord, files, links, decisions, and criteria, and drops
 * `implementationPlan` (often the largest column) and assignees because the
 * record bundle never renders them.
 *
 * Invariant: `agent` must keep every flag `planning` and `working` keep —
 * `resolveContextBundle` fetches once at `agent` depth and feeds all three
 * cores. Exported so the invariant test can pin this.
 */
export const DEPTH_PROJECTIONS: Record<TaskFetchDepth, DepthProjection> = {
  summary: {
    tags: false,
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
    implementationPlan: true,
    executionRecord: false,
    files: false,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  agent: {
    tags: true,
    implementationPlan: true,
    executionRecord: true,
    files: true,
    assignees: true,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  review: {
    tags: true,
    implementationPlan: true,
    executionRecord: true,
    files: true,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
  record: {
    tags: true,
    implementationPlan: false,
    executionRecord: true,
    files: true,
    assignees: false,
    acceptanceCriteria: true,
    decisions: true,
    links: true,
  },
};

/** Correlated assignee aggregate, identical to {@link fetchTaskFull}. */
const ASSIGNEES_AGG = sql`(SELECT json_agg(json_build_object('userId', a.user_id, 'name', a.name, 'email', a.email) ORDER BY a.name)
         FROM public.task_assignees_visible(t.id) a)`;

/** Correlated acceptance-criteria aggregate, identical to {@link fetchTaskFull}. */
const CRITERIA_AGG = sql`(SELECT json_agg(json_build_object('id', c.id, 'text', c.text, 'checked', c.checked) ORDER BY c.position, c.id)
         FROM task_acceptance_criteria c
         WHERE c.task_id = t.id)`;

/** Correlated decisions aggregate, identical to {@link fetchTaskFull}. */
const DECISIONS_AGG = sql`(SELECT json_agg(json_build_object('id', d.id, 'text', d.text, 'source', d.source, 'date', d.decision_date) ORDER BY d.position, d.id)
         FROM task_decisions d
         WHERE d.task_id = t.id)`;

/** Correlated links aggregate, identical to {@link fetchTaskFull}. */
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
  nullCast: "text" | "jsonb",
): SQL {
  const aliasId = sql.identifier(alias);
  return keep
    ? sql`${column} AS ${aliasId}`
    : sql`NULL::${sql.raw(nullCast)} AS ${aliasId}`;
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
 * Fetch the raw projection backing `getTaskForDepth` in a single round-trip,
 * narrowed to the columns and child aggregates the supplied {@link
 * TaskFetchDepth} renders. Columns no depth reads (`category`, `history`) and
 * columns this depth omits are returned as type-stable `NULL` literals so the
 * {@link TaskFullRawRow} shape is identical across depths.
 *
 * UNCHECKED: this helper performs NO authorization. The caller must assert
 * task access (`assertTaskAccess`) before invoking. Depth-aware sibling of
 * {@link fetchTaskFull}, which the web detail path uses.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the task.
 * @param depth - Context depth selecting the column projection.
 * @returns Zero or one rows; callers handle the missing case.
 */
export async function fetchTaskForDepth(
  conn: Conn,
  taskId: string,
  depth: TaskFetchDepth,
): Promise<TaskFullRawRow[]> {
  const p = DEPTH_PROJECTIONS[depth];
  return executeRaw<TaskFullRawRow>(
    conn,
    sql`
      SELECT
        t.id,
        t.project_id,
        t.title,
        t.sequence_number,
        t.description,
        t.status,
        t."order",
        NULL::text AS category,
        ${depthColumn(p.implementationPlan, sql`t.implementation_plan`, "implementation_plan", "text")},
        ${depthColumn(p.executionRecord, sql`t.execution_record`, "execution_record", "text")},
        ${depthColumn(p.tags, sql`t.tags`, "tags", "jsonb")},
        t.priority,
        t.estimate,
        ${depthColumn(p.files, sql`t.files`, "files", "jsonb")},
        '[]'::jsonb AS history,
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
    `,
  );
}

/**
 * Fetch the raw projection backing `getTaskFull` in a single round-trip.
 * Joins `tasks` to `projects` and folds `task_assignees`,
 * `task_acceptance_criteria`, `task_decisions`, and `task_links` into
 * JSON-aggregated subqueries.
 *
 * UNCHECKED: this helper performs NO authorization. The caller must
 * assert task access (`assertTaskAccess`) before invoking. Sibling of
 * `fetch-dependency-chain.ts` and `fetch-effective-downstream.ts`.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the task.
 * @returns Zero or one rows; callers handle the missing case.
 */
export async function fetchTaskFull(
  conn: Conn,
  taskId: string,
): Promise<TaskFullRawRow[]> {
  return executeRaw<TaskFullRawRow>(
    conn,
    sql`
      SELECT
        t.*,
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
    `,
  );
}
