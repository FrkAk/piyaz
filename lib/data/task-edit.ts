import "server-only";

import { and, asc, count, eq, sql } from "drizzle-orm";
import { withUserContext, type Tx } from "@/lib/db/rls";
import {
  projects,
  tasks,
  taskAcceptanceCriteria,
  taskDecisions,
  taskLinks,
  taskAssignees,
  type Task,
} from "@/lib/db/schema";
import {
  fetchTaskChildren,
  type TaskChildrenRow,
} from "@/lib/db/raw/fetch-task-children";
import {
  assertTaskAccessTx,
  ForbiddenError,
  isUuid,
} from "@/lib/auth/authorization";
import { classifyLink, MalformedLinkError } from "@/lib/links/classify";
import type { ClassifiedLink, LinkKind } from "@/lib/links/classify";
import {
  InvalidLinkUrlError,
  ProjectArchivedError,
  UnknownCategoryError,
} from "@/lib/graph/errors";
import type { ProjectStatus } from "@/lib/types";
import { formatTaskMarkdownFields } from "@/lib/markdown/format";
import { emitTaskEvent } from "@/lib/realtime/events";
import { assigneeSetChanged, taskRowMetaChanged } from "@/lib/data/task-clock";
import {
  insertActivityEvents,
  type ActivityEventInput,
} from "@/lib/data/activity";
import {
  applyPrUrlTx,
  assertAssigneesInTeam,
  deleteTask,
  deleteTaskPreview,
  diffTaskChanges,
  normalizeDecisions,
  setTaskAssignees,
  type UpdateTaskResult,
} from "@/lib/data/task";
import {
  TASK_STATUSES,
  type AcceptanceCriterion,
  type ActivityEventType,
  type Decision,
  type Estimate,
  type Priority,
  type TaskStatus,
} from "@/lib/types";
import type { AuthContext } from "@/lib/auth/context";
import { foldTextOp } from "@/lib/data/text-ops";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when `ifUpdatedAt` does not match the task's current `updatedAt`. */
export class StaleWriteError extends Error {
  /**
   * @param currentUpdatedAt - The task's live `updatedAt`, for the retry hint.
   */
  constructor(public readonly currentUpdatedAt: Date) {
    super(
      `Task changed since last read (updatedAt ${currentUpdatedAt.toISOString()})`,
    );
    this.name = "StaleWriteError";
  }
}

export {
  StrReplaceNoMatchError,
  StrReplaceMultipleMatchError,
} from "@/lib/data/text-ops";

/** Thrown when a by-id collection op references an item the task does not have. */
export class CollectionItemNotFoundError extends Error {
  /**
   * @param collection - The collection name.
   * @param id - The unmatched item id.
   * @param currentItems - The collection's live `{id, text}` pairs for recovery.
   */
  constructor(
    public readonly collection: string,
    public readonly id: string,
    public readonly currentItems: { id: string; text: string }[],
  ) {
    super(`No ${collection} item with id '${id}'`);
    this.name = "CollectionItemNotFoundError";
  }
}

/** Thrown when an op is structurally incoherent (missing/invalid arguments). */
export class InvalidEditOpError extends Error {
  /**
   * @param index - Zero-based index of the offending op.
   * @param reason - Corrective message naming the missing/invalid argument.
   */
  constructor(
    public readonly index: number,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = "InvalidEditOpError";
  }
}

/** Thrown when a link `update` would collide with another link's URL. */
export class DuplicateLinkUrlError extends Error {
  /**
   * @param url - The colliding URL already present on the task.
   */
  constructor(public readonly url: string) {
    super(`Task already has a link with url '${url}'`);
    this.name = "DuplicateLinkUrlError";
  }
}

// ---------------------------------------------------------------------------
// Public op + result shapes
// ---------------------------------------------------------------------------

/** A single operation-based task edit. */
export type EditOp = {
  op:
    | "str_replace"
    | "append"
    | "set"
    | "add"
    | "update"
    | "remove"
    | "check"
    | "uncheck"
    | "delete_task";
  field?:
    | "description"
    | "implementationPlan"
    | "executionRecord"
    | "status"
    | "priority"
    | "estimate"
    | "category"
    | "title"
    | "tags"
    | "files"
    | "prUrl";
  collection?: "acceptanceCriteria" | "decisions" | "links" | "assignees";
  oldStr?: string;
  newStr?: string;
  text?: string;
  value?: unknown;
  id?: string;
  checked?: boolean;
  url?: string;
  kind?: string;
  label?: string;
  preview?: boolean;
};

/**
 * Result of {@link applyTaskEdit}. The edit path returns the refetched task row
 * plus `applied`, the pre-edit `previousStatus` from the locked row, and
 * `links` (populated whenever the child refetch runs: a status set or any
 * collection op); the two `delete_task` paths are distinguishable by their
 * `task` (preview) vs `deleted` (execution) property.
 */
export type ApplyTaskEditResult =
  | (UpdateTaskResult & {
      applied: string[];
      previousStatus: TaskStatus;
      links: TaskChildrenRow["links"];
      projectStatus: ProjectStatus;
      projectIdentifier: string;
    })
  | (Awaited<ReturnType<typeof deleteTaskPreview>> & { applied: string[] })
  | (Awaited<ReturnType<typeof deleteTask>> & { applied: string[] });

// ---------------------------------------------------------------------------
// Field / collection vocabularies
// ---------------------------------------------------------------------------

/** Task text fields the text ops (`str_replace`/`append`/`set`) target. */
type TextField = "description" | "implementationPlan" | "executionRecord";
/** Row scalar fields foldable into a single `tasks` UPDATE. */
type RowScalarField =
  | "status"
  | "priority"
  | "estimate"
  | "category"
  | "title"
  | "tags"
  | "files";

const TEXT_FIELDS: readonly TextField[] = [
  "description",
  "implementationPlan",
  "executionRecord",
];
const ROW_FIELDS: readonly RowScalarField[] = [
  "status",
  "priority",
  "estimate",
  "category",
  "title",
  "tags",
  "files",
];
const PRIORITIES = [
  "urgent",
  "core",
  "normal",
  "backlog",
] as const satisfies readonly Priority[];
const ESTIMATES = [1, 2, 3, 5, 8, 13] as const satisfies readonly Estimate[];
const LINK_KINDS = [
  "pull_request",
  "issue",
  "commit",
  "doc",
  "link",
] as const satisfies readonly LinkKind[];

/** Defensive cap on ops per call. */
const MAX_OPS = 20;
/** Max length of `text` shown in a {@link CollectionItemNotFoundError}. */
const ITEM_TEXT_MAX = 80;

// ---------------------------------------------------------------------------
// Prepared (validated) op representation
// ---------------------------------------------------------------------------

/** A `str_replace`/`append`/`set` op narrowed to a text field. */
type PreparedText =
  | { t: "str_replace"; field: TextField; oldStr: string; newStr: string }
  | { t: "append"; field: TextField; text: string }
  | { t: "set"; field: TextField; value: string | null };
/** A by-id acceptance-criteria op. */
type PreparedCriteria =
  | { t: "add"; text: string; checked?: boolean }
  | { t: "update"; id: string; text?: string; checked?: boolean }
  | { t: "remove"; id: string }
  | { t: "check"; id: string; checked: boolean };
/** A by-id decision op. */
type PreparedDecision =
  | { t: "add"; text: string }
  | { t: "update"; id: string; text: string }
  | { t: "remove"; id: string };
/** A by-id link op; `add` pre-classifies the URL, `update` patches supplied fields. */
type PreparedLink =
  | { t: "add"; classified: ClassifiedLink }
  | {
      t: "update";
      id: string;
      patch: { url?: string; kind?: LinkKind; label?: string };
    }
  | { t: "remove"; id: string };
/** A by-id assignee op with `me` already resolved to the caller. */
type PreparedAssignee =
  | { t: "add"; userId: string }
  | { t: "remove"; userId: string };

/** A validated op ready to apply without further coherence checks. */
type PreparedOp =
  | { kind: "text"; op: PreparedText }
  | { kind: "row"; field: RowScalarField; value: unknown }
  | { kind: "prUrl"; classified: ClassifiedLink | null }
  | { kind: "criteria"; op: PreparedCriteria }
  | { kind: "decision"; op: PreparedDecision }
  | { kind: "link"; op: PreparedLink }
  | { kind: "assignee"; op: PreparedAssignee }
  | { kind: "delete"; preview: boolean };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string for display in an error payload.
 *
 * @param value - Source text.
 * @returns The value, or its first {@link ITEM_TEXT_MAX} chars with an ellipsis.
 */
function truncate(value: string): string {
  return value.length <= ITEM_TEXT_MAX
    ? value
    : `${value.slice(0, ITEM_TEXT_MAX - 1)}…`;
}

/**
 * Narrow a field name to a text field.
 *
 * @param field - Candidate field.
 * @returns Whether the field is a text field.
 */
function isTextField(field: string): field is TextField {
  return (TEXT_FIELDS as readonly string[]).includes(field);
}

/**
 * Narrow a field name to a row scalar field.
 *
 * @param field - Candidate field.
 * @returns Whether the field folds into the `tasks` UPDATE.
 */
function isRowField(field: string): field is RowScalarField {
  return (ROW_FIELDS as readonly string[]).includes(field);
}

/**
 * Test whether a value is an array of strings.
 *
 * @param value - Candidate value.
 * @returns Whether every element is a string.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Validate a by-id op target: present and UUID-shaped, so a malformed id
 * never reaches a Postgres `::uuid` cast as a raw driver error.
 *
 * @param id - Candidate item id.
 * @param requires - Message when the id is absent.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The validated id.
 */
function requireItemUuid(
  id: unknown,
  requires: string,
  bad: (reason: string) => never,
): string {
  if (typeof id !== "string") bad(requires);
  if (!isUuid(id))
    bad(
      `id '${id}' is not an item UUID. Read item ids via piyaz_get lens='working' or fields=[...].`,
    );
  return id;
}

/**
 * Classify a link URL, mapping a malformed URL to a typed validation error
 * the MCP translator renders as corrective copy (never "task not found").
 *
 * @param url - Candidate URL.
 * @param label - Field label used in the error message (`url` or `prUrl`).
 * @returns The classified link.
 * @throws InvalidLinkUrlError when the URL is malformed.
 */
function classifyOrReject(url: string, label: "url" | "prUrl"): ClassifiedLink {
  try {
    return classifyLink(url);
  } catch (e) {
    if (e instanceof MalformedLinkError) {
      throw new InvalidLinkUrlError(label, url);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Validation / preparation (runs before any DB work)
// ---------------------------------------------------------------------------

/**
 * Validate one op and narrow it to its {@link PreparedOp}. Structural coherence
 * (required args, enum membership) is enforced here; link/prUrl URLs are
 * classified so a malformed URL fails before the transaction opens.
 *
 * @param op - Raw caller op.
 * @param index - Position of the op, for error messages.
 * @param taskId - Task the edit targets.
 * @param userId - Caller id, used to resolve assignee `me`.
 * @returns The prepared op.
 * @throws InvalidEditOpError when the op is structurally incoherent.
 * @throws InvalidLinkUrlError when a link/prUrl URL is malformed.
 */
function prepareOp(
  op: EditOp,
  index: number,
  taskId: string,
  userId: string,
): PreparedOp {
  const bad = (reason: string): never => {
    throw new InvalidEditOpError(index, `operations[${index}]: ${reason}`);
  };
  switch (op.op) {
    case "str_replace":
    case "append":
    case "set":
      return prepareFieldOp(op, index, taskId, bad);
    case "add":
    case "update":
    case "remove":
    case "check":
    case "uncheck":
      return prepareCollectionOp(op, index, taskId, userId, bad);
    case "delete_task":
      return { kind: "delete", preview: op.preview !== false };
    default:
      return bad(`unknown op '${String(op.op)}'`);
  }
}

/**
 * Prepare a text/scalar `str_replace`/`append`/`set` op.
 *
 * @param op - Raw op (a text or scalar mutation).
 * @param index - Op position.
 * @param taskId - Task the edit targets.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The prepared op.
 */
function prepareFieldOp(
  op: EditOp,
  index: number,
  taskId: string,
  bad: (reason: string) => never,
): PreparedOp {
  const field = op.field;
  if (field === undefined) bad(`op='${op.op}' requires a field`);
  if (op.op === "str_replace") {
    if (!isTextField(field))
      bad(`str_replace field '${field}' is not a text field`);
    if (typeof op.oldStr !== "string" || op.oldStr.length === 0)
      bad("str_replace requires a non-empty oldStr");
    if (typeof op.newStr !== "string") bad("str_replace requires newStr");
    return {
      kind: "text",
      op: { t: "str_replace", field, oldStr: op.oldStr, newStr: op.newStr },
    };
  }
  if (op.op === "append") {
    if (!isTextField(field)) bad(`append field '${field}' is not a text field`);
    if (typeof op.text !== "string") bad("append requires text");
    return { kind: "text", op: { t: "append", field, text: op.text } };
  }
  return prepareSetOp(op, index, taskId, field, bad);
}

/**
 * Prepare a `set` op across text, prUrl, and row scalar fields.
 *
 * @param op - Raw `set` op.
 * @param index - Op position.
 * @param taskId - Task the edit targets.
 * @param field - The validated field name.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The prepared op.
 */
function prepareSetOp(
  op: EditOp,
  index: number,
  taskId: string,
  field: NonNullable<EditOp["field"]>,
  bad: (reason: string) => never,
): PreparedOp {
  if (isTextField(field)) {
    const value = op.text !== undefined ? op.text : op.value;
    if (value === undefined)
      bad(`set field '${field}' requires text (or value)`);
    if (field === "description") {
      if (typeof value !== "string")
        bad("set description requires string text");
      if (!value.trim())
        bad(
          "set description requires non-empty text; every task needs a description. To rework it, str_replace against the current text instead",
        );
      return { kind: "text", op: { t: "set", field, value } };
    }
    if (value !== null && typeof value !== "string")
      bad(`set ${field} requires string or null text`);
    return { kind: "text", op: { t: "set", field, value } };
  }
  if (!("value" in op)) bad(`set field '${field}' requires value`);
  const value = op.value;
  if (field === "prUrl") {
    if (value === null || value === "")
      return { kind: "prUrl", classified: null };
    if (typeof value !== "string")
      bad("set prUrl requires a string or null value");
    return {
      kind: "prUrl",
      classified: classifyOrReject(value, "prUrl"),
    };
  }
  if (!isRowField(field)) bad(`set field '${field}' is not settable`);
  validateRowValue(field, value, bad);
  return { kind: "row", field, value };
}

/**
 * Validate a row scalar value against its column's constraints.
 *
 * @param field - Row scalar field.
 * @param value - Candidate value.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 */
function validateRowValue(
  field: RowScalarField,
  value: unknown,
  bad: (reason: string) => never,
): void {
  switch (field) {
    case "status":
      if (!(TASK_STATUSES as readonly unknown[]).includes(value))
        bad(`set status requires one of ${TASK_STATUSES.join(", ")}`);
      return;
    case "priority":
      if (value !== null && !(PRIORITIES as readonly unknown[]).includes(value))
        bad(`set priority requires null or one of ${PRIORITIES.join(", ")}`);
      return;
    case "estimate":
      if (value !== null && !(ESTIMATES as readonly unknown[]).includes(value))
        bad(`set estimate requires null or one of ${ESTIMATES.join(", ")}`);
      return;
    case "category":
      if (value !== null && typeof value !== "string")
        bad("set category requires a string or null value");
      return;
    case "title":
      if (typeof value !== "string" || !value.trim())
        bad("set title requires non-empty text (verb+noun, imperative)");
      return;
    case "tags":
      if (!isStringArray(value)) bad("set tags requires an array of strings");
      return;
    case "files":
      if (!isStringArray(value)) bad("set files requires an array of strings");
  }
}

/**
 * Prepare an `add`/`update`/`remove`/`check`/`uncheck` collection op.
 *
 * @param op - Raw collection op.
 * @param index - Op position.
 * @param taskId - Task the edit targets.
 * @param userId - Caller id, used to resolve assignee `me`.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The prepared op.
 */
function prepareCollectionOp(
  op: EditOp,
  index: number,
  taskId: string,
  userId: string,
  bad: (reason: string) => never,
): PreparedOp {
  const collection = op.collection;
  if (collection === undefined) bad(`op='${op.op}' requires a collection`);
  if (op.op === "check" || op.op === "uncheck") {
    if (collection !== "acceptanceCriteria")
      bad(`op='${op.op}' is only valid on acceptanceCriteria`);
    const id = requireItemUuid(op.id, `op='${op.op}' requires id`, bad);
    return {
      kind: "criteria",
      op: { t: "check", id, checked: op.op === "check" },
    };
  }
  switch (collection) {
    case "acceptanceCriteria":
      return { kind: "criteria", op: prepareCriteriaMutation(op, bad) };
    case "decisions":
      return { kind: "decision", op: prepareDecisionMutation(op, bad) };
    case "links":
      return { kind: "link", op: prepareLinkMutation(op, taskId, bad) };
    case "assignees":
      return { kind: "assignee", op: prepareAssigneeMutation(op, userId, bad) };
    default:
      return bad(`unknown collection '${String(collection)}'`);
  }
}

/**
 * Prepare an acceptance-criteria `add`/`update`/`remove`.
 *
 * @param op - Raw op.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The prepared criteria mutation.
 */
function prepareCriteriaMutation(
  op: EditOp,
  bad: (reason: string) => never,
): PreparedCriteria {
  if (op.op === "add") {
    if (typeof op.text !== "string" || op.text.trim() === "")
      bad("add acceptanceCriteria requires non-empty text");
    if (op.checked !== undefined && typeof op.checked !== "boolean")
      bad("acceptanceCriteria checked must be a boolean");
    return { t: "add", text: op.text.trim(), checked: op.checked };
  }
  if (op.op === "remove") {
    const id = requireItemUuid(
      op.id,
      "remove acceptanceCriteria requires id",
      bad,
    );
    return { t: "remove", id };
  }
  if (op.op === "update") {
    const id = requireItemUuid(
      op.id,
      "update acceptanceCriteria requires id",
      bad,
    );
    if (op.text === undefined && op.checked === undefined)
      bad("update acceptanceCriteria requires text or checked");
    if (
      op.text !== undefined &&
      (typeof op.text !== "string" || op.text.trim() === "")
    )
      bad("acceptanceCriteria text must be a non-empty string");
    if (op.checked !== undefined && typeof op.checked !== "boolean")
      bad("acceptanceCriteria checked must be a boolean");
    return { t: "update", id, text: op.text?.trim(), checked: op.checked };
  }
  return bad(`op='${op.op}' is not valid on acceptanceCriteria`);
}

/**
 * Prepare a decision `add`/`update`/`remove`.
 *
 * @param op - Raw op.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The prepared decision mutation.
 */
function prepareDecisionMutation(
  op: EditOp,
  bad: (reason: string) => never,
): PreparedDecision {
  if (op.op === "add") {
    if (typeof op.text !== "string" || op.text.trim() === "")
      bad("add decisions requires non-empty text");
    return { t: "add", text: op.text.trim() };
  }
  if (op.op === "remove") {
    const id = requireItemUuid(op.id, "remove decisions requires id", bad);
    return { t: "remove", id };
  }
  if (op.op === "update") {
    const id = requireItemUuid(op.id, "update decisions requires id", bad);
    if (typeof op.text !== "string" || op.text.trim() === "")
      bad("update decisions requires non-empty text");
    return { t: "update", id, text: op.text.trim() };
  }
  return bad(`op='${op.op}' is not valid on decisions`);
}

/**
 * Prepare a link `add`/`update`/`remove`. `add` classifies the URL; a
 * caller-supplied `kind` (validated against {@link LINK_KINDS}) or non-empty
 * `label` overrides the classifier's derivation. `update` is a partial patch:
 * only the supplied fields change, unsupplied fields keep their stored values.
 *
 * @param op - Raw op.
 * @param taskId - Task the edit targets.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The prepared link mutation.
 */
function prepareLinkMutation(
  op: EditOp,
  taskId: string,
  bad: (reason: string) => never,
): PreparedLink {
  const overridden = (url: string): ClassifiedLink => {
    const classified = classifyOrReject(url, "url");
    if (
      op.kind !== undefined &&
      !(LINK_KINDS as readonly string[]).includes(op.kind)
    )
      bad(`links kind '${op.kind}' must be one of ${LINK_KINDS.join(", ")}`);
    const label = op.label?.trim();
    return {
      ...classified,
      ...(op.kind !== undefined && { kind: op.kind as LinkKind }),
      ...(label && { label }),
    };
  };
  if (op.op === "add") {
    if (typeof op.url !== "string") bad("add links requires url");
    return { t: "add", classified: overridden(op.url) };
  }
  if (op.op === "remove") {
    const id = requireItemUuid(op.id, "remove links requires id", bad);
    return { t: "remove", id };
  }
  if (op.op === "update") {
    const id = requireItemUuid(op.id, "update links requires id", bad);
    if (op.url === undefined && op.kind === undefined && op.label === undefined)
      bad("update links requires at least one of url, kind, label");
    if (op.url !== undefined && typeof op.url !== "string")
      bad("links url must be a string");
    if (
      op.kind !== undefined &&
      !(LINK_KINDS as readonly string[]).includes(op.kind)
    )
      bad(`links kind '${op.kind}' must be one of ${LINK_KINDS.join(", ")}`);
    const url =
      op.url !== undefined ? classifyOrReject(op.url, "url").url : undefined;
    const label = op.label?.trim();
    return {
      t: "update",
      id,
      patch: {
        ...(url !== undefined && { url }),
        ...(op.kind !== undefined && { kind: op.kind as LinkKind }),
        ...(label && { label }),
      },
    };
  }
  return bad(`op='${op.op}' is not valid on links`);
}

/**
 * Prepare an assignee `add`/`remove`, resolving `me` to the caller.
 *
 * @param op - Raw op.
 * @param userId - Caller id.
 * @param bad - Throws {@link InvalidEditOpError} with the op index.
 * @returns The prepared assignee mutation.
 */
function prepareAssigneeMutation(
  op: EditOp,
  userId: string,
  bad: (reason: string) => never,
): PreparedAssignee {
  if (op.op !== "add" && op.op !== "remove")
    return bad(`op='${op.op}' is not valid on assignees`);
  const raw = typeof op.value === "string" ? op.value : op.id;
  if (typeof raw !== "string")
    bad(`${op.op} assignees requires value ('me' or a user UUID)`);
  if (raw !== "me" && !isUuid(raw))
    bad(`assignees value '${raw}' must be 'me' or a user UUID`);
  const resolved = raw === "me" ? userId : raw;
  return op.op === "add"
    ? { t: "add", userId: resolved }
    : { t: "remove", userId: resolved };
}

/**
 * Validate every op and narrow the batch. Enforces the op cap and the rule
 * that `delete_task` is the only op in the array.
 *
 * @param ops - Raw caller ops.
 * @param taskId - Task the edit targets.
 * @param userId - Caller id.
 * @returns The prepared ops in order.
 * @throws InvalidEditOpError on any coherence violation.
 * @throws InvalidLinkUrlError when a link/prUrl URL is malformed.
 */
function prepareOps(
  ops: EditOp[],
  taskId: string,
  userId: string,
): PreparedOp[] {
  if (ops.length === 0)
    throw new InvalidEditOpError(
      0,
      "operations[0]: at least one op is required",
    );
  if (ops.length > MAX_OPS)
    throw new InvalidEditOpError(
      MAX_OPS,
      `operations[${MAX_OPS}]: at most ${MAX_OPS} ops per call`,
    );
  const deleteIndex = ops.findIndex((o) => o.op === "delete_task");
  if (deleteIndex !== -1 && ops.length > 1)
    throw new InvalidEditOpError(
      deleteIndex,
      `operations[${deleteIndex}]: delete_task must be the only op`,
    );
  return ops.map((op, i) => prepareOp(op, i, taskId, userId));
}

// ---------------------------------------------------------------------------
// Collection appliers (inside the transaction)
// ---------------------------------------------------------------------------

/** Outcome of one applied collection op: the event, label, and refetch flag. */
type CollectionOutcome = {
  event: ActivityEventInput | null;
  applied: string;
  refetch: boolean;
};

/**
 * Fetch a collection's `{id, text}` pairs for a not-found error payload.
 *
 * @param rows - Rows with `id` and a display `text`.
 * @returns Truncated pairs.
 */
function toItems(rows: { id: string; text: string }[]): {
  id: string;
  text: string;
}[] {
  return rows.map((r) => ({ id: r.id, text: truncate(r.text) }));
}

/**
 * Apply an acceptance-criteria mutation against the child table.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param projectId - Owning project id.
 * @param op - Prepared criteria mutation.
 * @returns The activity event and applied label.
 * @throws CollectionItemNotFoundError when a by-id target does not exist.
 */
async function applyCriteria(
  tx: Tx,
  taskId: string,
  projectId: string,
  op: PreparedCriteria,
): Promise<CollectionOutcome> {
  const base = { projectId, taskId };
  if (op.t === "add") {
    const existing = await selectCriterionByText(tx, taskId, op.text);
    if (existing) return dedupeCriteriaAdd(tx, base, op, existing);
    const [inserted] = await tx
      .insert(taskAcceptanceCriteria)
      .values({
        id: crypto.randomUUID(),
        taskId,
        text: op.text,
        checked: op.checked ?? false,
        position: sql<number>`(SELECT COALESCE(MAX("position"), -1) FROM "task_acceptance_criteria" WHERE "task_id" = ${taskId}::uuid) + 1`,
      })
      .onConflictDoNothing({
        target: [taskAcceptanceCriteria.taskId, taskAcceptanceCriteria.text],
      })
      .returning({ id: taskAcceptanceCriteria.id });
    if (!inserted) {
      const raced = await selectCriterionByText(tx, taskId, op.text);
      if (raced) return dedupeCriteriaAdd(tx, base, op, raced);
      throw new Error(
        "add acceptanceCriteria raced with a concurrent delete; transaction rolled back",
      );
    }
    return {
      event: {
        ...base,
        type: "criterion_added",
        summary: `added criterion "${op.text}"`,
        targetRef: inserted.id,
      },
      applied: `add acceptanceCriteria ${inserted.id}`,
      refetch: true,
    };
  }
  if (op.t === "remove") {
    const deleted = await tx
      .delete(taskAcceptanceCriteria)
      .where(
        and(
          eq(taskAcceptanceCriteria.id, op.id),
          eq(taskAcceptanceCriteria.taskId, taskId),
        ),
      )
      .returning({ id: taskAcceptanceCriteria.id });
    if (deleted.length === 0)
      throw new CollectionItemNotFoundError(
        "acceptanceCriteria",
        op.id,
        await fetchCriteriaItems(tx, taskId),
      );
    return {
      event: {
        ...base,
        type: "criterion_removed",
        summary: "removed a criterion",
        targetRef: op.id,
      },
      applied: `remove acceptanceCriteria ${op.id}`,
      refetch: true,
    };
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  let type: ActivityEventType;
  let verb: string;
  let summary: string;
  if (op.t === "check") {
    set.checked = op.checked;
    type = op.checked ? "criterion_checked" : "criterion_unchecked";
    verb = op.checked ? "check" : "uncheck";
    summary = op.checked ? "checked a criterion" : "unchecked a criterion";
  } else {
    if (op.text !== undefined) set.text = op.text;
    if (op.checked !== undefined) set.checked = op.checked;
    type = "criterion_edited";
    verb = "update";
    summary = "edited a criterion";
  }
  const updated = await tx
    .update(taskAcceptanceCriteria)
    .set(set)
    .where(
      and(
        eq(taskAcceptanceCriteria.id, op.id),
        eq(taskAcceptanceCriteria.taskId, taskId),
      ),
    )
    .returning({ id: taskAcceptanceCriteria.id });
  if (updated.length === 0)
    throw new CollectionItemNotFoundError(
      "acceptanceCriteria",
      op.id,
      await fetchCriteriaItems(tx, taskId),
    );
  return {
    event: { ...base, type, summary, targetRef: op.id },
    applied: `${verb} acceptanceCriteria ${op.id}`,
    refetch: true,
  };
}

/**
 * Select a criterion by its `(taskId, text)` for dedup on `add`.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param text - Criterion text to match.
 * @returns The matched row's id and `checked`, or undefined.
 */
async function selectCriterionByText(
  tx: Tx,
  taskId: string,
  text: string,
): Promise<{ id: string; checked: boolean } | undefined> {
  const [row] = await tx
    .select({
      id: taskAcceptanceCriteria.id,
      checked: taskAcceptanceCriteria.checked,
    })
    .from(taskAcceptanceCriteria)
    .where(
      and(
        eq(taskAcceptanceCriteria.taskId, taskId),
        eq(taskAcceptanceCriteria.text, text),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Resolve an acceptance-criteria `add` that matched an existing row. Flips
 * `checked` only when the op supplies a value differing from the existing one;
 * an omitted or equal `checked` changes nothing. Never emits `criterion_added`.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param base - Shared `{projectId, taskId}` event fields.
 * @param op - The prepared `add` op.
 * @param existing - The matched row's id and current `checked`.
 * @returns The dedup outcome: a check/uncheck event when flipped, else null.
 */
async function dedupeCriteriaAdd(
  tx: Tx,
  base: { projectId: string; taskId: string },
  op: { text: string; checked?: boolean },
  existing: { id: string; checked: boolean },
): Promise<CollectionOutcome> {
  const applied = `add acceptanceCriteria ${existing.id} (deduped)`;
  if (op.checked === undefined || op.checked === existing.checked)
    return { event: null, applied, refetch: true };
  await tx
    .update(taskAcceptanceCriteria)
    .set({ checked: op.checked, updatedAt: new Date() })
    .where(eq(taskAcceptanceCriteria.id, existing.id));
  return {
    event: {
      ...base,
      type: op.checked ? "criterion_checked" : "criterion_unchecked",
      summary: op.checked ? "checked a criterion" : "unchecked a criterion",
      targetRef: existing.id,
    },
    applied,
    refetch: true,
  };
}

/**
 * Apply a decision mutation against the child table.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param projectId - Owning project id.
 * @param op - Prepared decision mutation.
 * @returns The activity event and applied label.
 * @throws CollectionItemNotFoundError when a by-id target does not exist.
 */
async function applyDecision(
  tx: Tx,
  taskId: string,
  projectId: string,
  op: PreparedDecision,
): Promise<CollectionOutcome> {
  const base = { projectId, taskId };
  if (op.t === "add") {
    const existing = await selectDecisionByText(tx, taskId, op.text);
    if (existing)
      return {
        event: null,
        applied: `add decisions ${existing.id} (deduped)`,
        refetch: true,
      };
    const [decision] = normalizeDecisions([op.text]);
    const [inserted] = await tx
      .insert(taskDecisions)
      .values({
        id: decision.id,
        taskId,
        text: decision.text,
        source: decision.source,
        decisionDate: decision.date,
        position: sql<number>`(SELECT COALESCE(MAX("position"), -1) FROM "task_decisions" WHERE "task_id" = ${taskId}::uuid) + 1`,
      })
      .onConflictDoNothing({
        target: [taskDecisions.taskId, taskDecisions.text],
      })
      .returning({ id: taskDecisions.id });
    if (!inserted) {
      const raced = await selectDecisionByText(tx, taskId, op.text);
      if (raced)
        return {
          event: null,
          applied: `add decisions ${raced.id} (deduped)`,
          refetch: true,
        };
      throw new Error(
        "add decisions raced with a concurrent delete; transaction rolled back",
      );
    }
    return {
      event: {
        ...base,
        type: "decision_added",
        summary: `recorded decision "${op.text}"`,
        targetRef: inserted.id,
      },
      applied: `add decisions ${inserted.id}`,
      refetch: true,
    };
  }
  if (op.t === "remove") {
    const deleted = await tx
      .delete(taskDecisions)
      .where(and(eq(taskDecisions.id, op.id), eq(taskDecisions.taskId, taskId)))
      .returning({ id: taskDecisions.id });
    if (deleted.length === 0)
      throw new CollectionItemNotFoundError(
        "decisions",
        op.id,
        await fetchDecisionItems(tx, taskId),
      );
    return {
      event: {
        ...base,
        type: "decision_removed",
        summary: "removed a decision",
        targetRef: op.id,
      },
      applied: `remove decisions ${op.id}`,
      refetch: true,
    };
  }
  const updated = await tx
    .update(taskDecisions)
    .set({ text: op.text, updatedAt: new Date() })
    .where(and(eq(taskDecisions.id, op.id), eq(taskDecisions.taskId, taskId)))
    .returning({ id: taskDecisions.id });
  if (updated.length === 0)
    throw new CollectionItemNotFoundError(
      "decisions",
      op.id,
      await fetchDecisionItems(tx, taskId),
    );
  return {
    event: {
      ...base,
      type: "decision_edited",
      summary: "edited a decision",
      targetRef: op.id,
    },
    applied: `update decisions ${op.id}`,
    refetch: true,
  };
}

/**
 * Select a decision by its `(taskId, text)` for dedup on `add`.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param text - Decision text to match.
 * @returns The matched row's id, or undefined.
 */
async function selectDecisionByText(
  tx: Tx,
  taskId: string,
  text: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: taskDecisions.id })
    .from(taskDecisions)
    .where(and(eq(taskDecisions.taskId, taskId), eq(taskDecisions.text, text)))
    .limit(1);
  return row;
}

/**
 * Apply a link mutation scoped to the edited task, reusing `classifyLink`'s
 * kind/label derivation. Link ops on another task's link id surface as a
 * {@link CollectionItemNotFoundError} so the edit stays scoped to `taskId`.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param projectId - Owning project id.
 * @param op - Prepared link mutation.
 * @param createdBy - Caller id for the `created_by` column on inserts.
 * @returns The activity event (null on a deduped add) and applied label.
 * @throws CollectionItemNotFoundError when a by-id target is not on the task.
 * @throws DuplicateLinkUrlError when an update collides with another link's URL.
 */
async function applyLink(
  tx: Tx,
  taskId: string,
  projectId: string,
  op: PreparedLink,
  createdBy: string,
): Promise<CollectionOutcome> {
  const base = { projectId, taskId };
  if (op.t === "add") {
    const c = op.classified;
    const [inserted] = await tx
      .insert(taskLinks)
      .values({
        taskId,
        kind: c.kind,
        url: c.url,
        label: c.label,
        createdBy,
      })
      .onConflictDoNothing({ target: [taskLinks.taskId, taskLinks.url] })
      .returning({ id: taskLinks.id });
    if (inserted)
      return {
        event: {
          ...base,
          type: "link_added",
          summary: `linked ${c.label ?? c.kind}`,
          targetRef: c.url,
        },
        applied: `add links ${inserted.id}`,
        refetch: false,
      };
    const [existing] = await tx
      .select({ id: taskLinks.id })
      .from(taskLinks)
      .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.url, c.url)))
      .limit(1);
    return {
      event: null,
      applied: `add links ${existing?.id ?? c.url}`,
      refetch: false,
    };
  }
  if (op.t === "remove") {
    const [row] = await tx
      .select({
        id: taskLinks.id,
        url: taskLinks.url,
        label: taskLinks.label,
        kind: taskLinks.kind,
      })
      .from(taskLinks)
      .where(and(eq(taskLinks.id, op.id), eq(taskLinks.taskId, taskId)))
      .limit(1);
    if (!row)
      throw new CollectionItemNotFoundError(
        "links",
        op.id,
        await fetchLinkItems(tx, taskId),
      );
    await tx.delete(taskLinks).where(eq(taskLinks.id, op.id));
    return {
      event: {
        ...base,
        type: "link_removed",
        summary: `removed link ${row.label ?? row.kind}`,
        targetRef: row.url,
      },
      applied: `remove links ${op.id}`,
      refetch: false,
    };
  }
  const { patch } = op;
  const [row] = await tx
    .select({
      url: taskLinks.url,
      kind: taskLinks.kind,
      label: taskLinks.label,
    })
    .from(taskLinks)
    .where(and(eq(taskLinks.id, op.id), eq(taskLinks.taskId, taskId)))
    .limit(1);
  if (!row)
    throw new CollectionItemNotFoundError(
      "links",
      op.id,
      await fetchLinkItems(tx, taskId),
    );
  if (patch.url !== undefined && patch.url !== row.url) {
    const [conflict] = await tx
      .select({ id: taskLinks.id })
      .from(taskLinks)
      .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.url, patch.url)))
      .limit(1);
    if (conflict) throw new DuplicateLinkUrlError(patch.url);
  }
  const next = {
    kind: patch.kind ?? row.kind,
    url: patch.url ?? row.url,
    label: patch.label ?? row.label,
  };
  await tx.update(taskLinks).set(next).where(eq(taskLinks.id, op.id));
  return {
    event: {
      ...base,
      type: "link_updated",
      summary: `updated link to ${next.label ?? next.kind}`,
      targetRef: next.url,
    },
    applied: `update links ${op.id}`,
    refetch: false,
  };
}

/**
 * Apply an assignee mutation, gating adds on team membership.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param projectId - Owning project id.
 * @param op - Prepared assignee mutation.
 * @returns The activity event and applied label.
 * @throws ForbiddenError when an added user is not a team member.
 * @throws CollectionItemNotFoundError when a removed user is not assigned.
 */
async function applyAssignee(
  tx: Tx,
  taskId: string,
  projectId: string,
  op: PreparedAssignee,
): Promise<CollectionOutcome> {
  const base = { projectId, taskId };
  if (op.t === "add") {
    await assertAssigneesInTeam(tx, projectId, [op.userId]);
    await setTaskAssignees(tx, taskId, [op.userId], "append");
    return {
      event: {
        ...base,
        type: "assignee_added",
        summary: "added an assignee",
        targetRef: op.userId,
      },
      applied: `add assignees ${op.userId}`,
      refetch: false,
    };
  }
  const deleted = await tx
    .delete(taskAssignees)
    .where(
      and(
        eq(taskAssignees.taskId, taskId),
        eq(taskAssignees.userId, op.userId),
      ),
    )
    .returning({ userId: taskAssignees.userId });
  if (deleted.length === 0)
    throw new CollectionItemNotFoundError(
      "assignees",
      op.userId,
      await fetchAssigneeItems(tx, taskId),
    );
  return {
    event: {
      ...base,
      type: "assignee_removed",
      summary: "removed an assignee",
      targetRef: op.userId,
    },
    applied: `remove assignees ${op.userId}`,
    refetch: false,
  };
}

/**
 * Load the task's acceptance criteria as not-found error items.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @returns Truncated `{id, text}` pairs in position order.
 */
async function fetchCriteriaItems(
  tx: Tx,
  taskId: string,
): Promise<{ id: string; text: string }[]> {
  const rows = await tx
    .select({
      id: taskAcceptanceCriteria.id,
      text: taskAcceptanceCriteria.text,
    })
    .from(taskAcceptanceCriteria)
    .where(eq(taskAcceptanceCriteria.taskId, taskId))
    .orderBy(
      asc(taskAcceptanceCriteria.position),
      asc(taskAcceptanceCriteria.id),
    );
  return toItems(rows);
}

/**
 * Load the task's decisions as not-found error items.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @returns Truncated `{id, text}` pairs in position order.
 */
async function fetchDecisionItems(
  tx: Tx,
  taskId: string,
): Promise<{ id: string; text: string }[]> {
  const rows = await tx
    .select({ id: taskDecisions.id, text: taskDecisions.text })
    .from(taskDecisions)
    .where(eq(taskDecisions.taskId, taskId))
    .orderBy(asc(taskDecisions.position), asc(taskDecisions.id));
  return toItems(rows);
}

/**
 * Load the task's links as not-found error items (label falls back to URL).
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @returns Truncated `{id, text}` pairs in creation order.
 */
async function fetchLinkItems(
  tx: Tx,
  taskId: string,
): Promise<{ id: string; text: string }[]> {
  const rows = await tx
    .select({ id: taskLinks.id, url: taskLinks.url, label: taskLinks.label })
    .from(taskLinks)
    .where(eq(taskLinks.taskId, taskId))
    .orderBy(asc(taskLinks.createdAt));
  return toItems(rows.map((r) => ({ id: r.id, text: r.label ?? r.url })));
}

/**
 * Load the task's assignee user ids as not-found error items.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @returns Each assignee id as both `id` and `text`.
 */
async function fetchAssigneeItems(
  tx: Tx,
  taskId: string,
): Promise<{ id: string; text: string }[]> {
  const rows = await tx
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId));
  return rows.map((r) => ({ id: r.userId, text: r.userId }));
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** In-memory accumulation of text/scalar edits during the op loop. */
type EditAccumulator = {
  textState: Record<TextField, string | null>;
  dirtyText: Set<TextField>;
  rowChanges: Record<string, unknown>;
  statusSet: boolean;
};

/**
 * Fold a prepared text op into the running text state via the shared
 * engine (`lib/data/text-ops.ts`), keeping task and note editors on one
 * set of semantics and error copy.
 *
 * @param acc - Edit accumulator.
 * @param op - Prepared text op.
 */
function applyTextOp(acc: EditAccumulator, op: PreparedText): void {
  acc.textState[op.field] = foldTextOp(acc.textState[op.field], op);
  acc.dirtyText.add(op.field);
}

/**
 * Fold the dirty text fields into `rowChanges`, applying markdown formatting to
 * their final values (matching `updateTask`).
 *
 * @param acc - Edit accumulator.
 */
async function foldFormattedText(acc: EditAccumulator): Promise<void> {
  if (acc.dirtyText.size === 0) return;
  const input: Record<string, unknown> = {};
  for (const field of acc.dirtyText) input[field] = acc.textState[field];
  const formatted = await formatTaskMarkdownFields(input);
  for (const field of acc.dirtyText) acc.rowChanges[field] = formatted[field];
}

/**
 * Apply an operation-based edit to a task atomically. Validates every op first,
 * routes `delete_task` before opening a transaction, then applies text, scalar,
 * and by-id collection ops in order inside one transaction — a failing op rolls
 * back every earlier op. The task row is read `FOR UPDATE`, so concurrent edits
 * to the same task serialize and a stale `ifUpdatedAt` fails deterministically
 * instead of last-write-wins. Text/scalar changes emit the same activity events
 * as `updateTask`; each collection op emits its own event.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task to edit.
 * @param ops - Ordered operations (capped at {@link MAX_OPS}).
 * @param ifUpdatedAt - Optional optimistic-concurrency precondition; the task's
 *   current `updatedAt` must match to millisecond precision.
 * @returns The refetched task row plus `applied` labels, the pre-edit
 *   `previousStatus`, and `links` (when the child refetch runs), or the
 *   `delete_task` preview/execution result.
 * @throws InvalidEditOpError on op incoherence.
 * @throws StaleWriteError when `ifUpdatedAt` does not match.
 * @throws StrReplaceNoMatchError / StrReplaceMultipleMatchError on bad replaces.
 * @throws CollectionItemNotFoundError when a by-id target is missing.
 * @throws DuplicateLinkUrlError when a link update collides with another URL.
 * @throws ForbiddenError when access or an assignee is rejected.
 * @throws InvalidLinkUrlError when a link/prUrl URL is malformed.
 * @throws UnknownCategoryError when a category set is outside the vocabulary.
 * @throws ProjectArchivedError when the parent project is archived (read-only);
 *   `delete_task` previews are exempt (read-only path).
 */
export async function applyTaskEdit(
  ctx: AuthContext,
  taskId: string,
  ops: EditOp[],
  ifUpdatedAt?: string,
): Promise<ApplyTaskEditResult> {
  const prepared = prepareOps(ops, taskId, ctx.userId);

  let ifUpdatedAtMs: number | undefined;
  if (ifUpdatedAt !== undefined) {
    ifUpdatedAtMs = new Date(ifUpdatedAt).getTime();
    if (Number.isNaN(ifUpdatedAtMs))
      throw new InvalidEditOpError(
        0,
        `ifUpdatedAt '${ifUpdatedAt}' is not a valid timestamp. Pass the updatedAt emitted by your last piyaz_get read`,
      );
  }

  const first = prepared[0];
  if (prepared.length === 1 && first.kind === "delete") {
    if (ifUpdatedAtMs !== undefined)
      throw new InvalidEditOpError(
        0,
        "ifUpdatedAt is not supported with delete_task. Run the preview (default), confirm the impact, then re-run with preview=false",
      );
    if (first.preview) {
      const preview = await deleteTaskPreview(ctx, taskId);
      return { ...preview, applied: ["delete_task (preview)"] };
    }
    const deletion = await deleteTask(ctx, taskId);
    return { ...deletion, applied: ["delete_task"] };
  }

  const result = await withUserContext(ctx.userId, async (tx) => {
    const gate = await assertTaskAccessTx(tx, taskId);
    if (gate.projectStatus === "archived") {
      throw new ProjectArchivedError(gate.projectIdentifier);
    }
    const [current] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update");
    if (!current) throw new ForbiddenError("Forbidden", "task", taskId);

    if (
      ifUpdatedAtMs !== undefined &&
      ifUpdatedAtMs !== new Date(current.updatedAt).getTime()
    ) {
      throw new StaleWriteError(current.updatedAt);
    }

    const projectId = current.projectId;
    await assertCategoryInVocabulary(tx, projectId, prepared);
    const acc: EditAccumulator = {
      textState: {
        description: current.description,
        implementationPlan: current.implementationPlan,
        executionRecord: current.executionRecord,
      },
      dirtyText: new Set(),
      rowChanges: {},
      statusSet: false,
    };
    const events: ActivityEventInput[] = [];
    const applied: string[] = [];
    let refetchNeeded = false;

    // Snapshot the child state the slim-visibility gate needs: the
    // hasCriteria flip compares row counts crossing zero, the assignee
    // gate compares the id set. Fetched only when matching ops exist.
    const hasCriteriaCountOps = prepared.some(
      (p) => p.kind === "criteria" && (p.op.t === "add" || p.op.t === "remove"),
    );
    const hasAssigneeOps = prepared.some((p) => p.kind === "assignee");
    const criteriaCountBefore = hasCriteriaCountOps
      ? await countCriteriaRows(tx, taskId)
      : 0;
    const assigneesBefore = hasAssigneeOps
      ? await listAssigneeUserIds(tx, taskId)
      : null;

    for (const prep of prepared) {
      const outcome = await applyPreparedOp(
        tx,
        taskId,
        projectId,
        ctx.userId,
        acc,
        prep,
      );
      if (outcome.event) events.push(outcome.event);
      applied.push(outcome.applied);
      if (outcome.refetch) refetchNeeded = true;
    }

    const criteriaCountAfter = hasCriteriaCountOps
      ? await countCriteriaRows(tx, taskId)
      : 0;
    const assigneesAfter = hasAssigneeOps
      ? await listAssigneeUserIds(tx, taskId)
      : null;

    await foldFormattedText(acc);
    const metaChanged =
      taskRowMetaChanged(current, acc.rowChanges) ||
      (hasCriteriaCountOps &&
        criteriaCountBefore > 0 !== criteriaCountAfter > 0) ||
      (assigneesBefore !== null &&
        assigneesAfter !== null &&
        assigneeSetChanged(assigneesBefore, assigneesAfter));
    const now = new Date();
    const [row] = await tx
      .update(tasks)
      .set({
        ...acc.rowChanges,
        updatedAt: now,
        ...(metaChanged ? { metaUpdatedAt: now } : {}),
      })
      .where(eq(tasks.id, taskId))
      .returning();

    const diffEvents = diffTaskChanges(
      projectId,
      taskId,
      current,
      acc.rowChanges as Partial<Task>,
    );
    const allEvents = [...diffEvents, ...events];
    if (allEvents.length > 0)
      await insertActivityEvents(tx, ctx.actor, allEvents);

    if (acc.statusSet) refetchNeeded = true;
    let criteriaResult: AcceptanceCriterion[] | null = null;
    let decisionsResult: Decision[] | null = null;
    let linksResult: TaskChildrenRow["links"] = null;
    if (refetchNeeded) {
      const children = await fetchTaskChildren(tx, taskId);
      criteriaResult = (children.acceptance_criteria ?? []).map((c) => ({
        id: c.id,
        text: c.text,
        checked: c.checked,
      }));
      decisionsResult = (children.decisions ?? []).map((d) => ({
        id: d.id,
        text: d.text,
        source: d.source as Decision["source"],
        date: d.date,
      }));
      linksResult = children.links;
    }
    return {
      row,
      criteriaResult,
      decisionsResult,
      linksResult,
      applied,
      previousStatus: current.status,
      projectStatus: gate.projectStatus,
      projectIdentifier: gate.projectIdentifier,
      metaChanged,
    };
  });

  emitTaskEvent(result.row.projectId, taskId, {
    metaChanged: result.metaChanged,
    updatedAt: result.row.updatedAt,
  });
  return Object.assign(result.row, {
    acceptanceCriteria: result.criteriaResult,
    decisions: result.decisionsResult,
    links: result.linksResult,
    applied: result.applied,
    previousStatus: result.previousStatus,
    projectStatus: result.projectStatus,
    projectIdentifier: result.projectIdentifier,
  });
}

/**
 * Count acceptance-criteria rows for a task.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - UUID of the task.
 * @returns The number of criteria rows.
 */
async function countCriteriaRows(tx: Tx, taskId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(taskAcceptanceCriteria)
    .where(eq(taskAcceptanceCriteria.taskId, taskId));
  return row?.n ?? 0;
}

/**
 * List assignee user ids for a task.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - UUID of the task.
 * @returns The assignee user ids.
 */
async function listAssigneeUserIds(tx: Tx, taskId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId));
  return rows.map((r) => r.userId);
}

/**
 * Validate every `set category` op against the project's closed vocabulary.
 * A project with an empty vocabulary accepts anything (categories are
 * optional); setting `null` always passes.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param projectId - Owning project id.
 * @param prepared - The call's prepared ops.
 * @throws UnknownCategoryError when a category is outside the vocabulary.
 */
async function assertCategoryInVocabulary(
  tx: Tx,
  projectId: string,
  prepared: PreparedOp[],
): Promise<void> {
  const categoryOps = prepared.filter(
    (p): p is Extract<PreparedOp, { kind: "row" }> =>
      p.kind === "row" && p.field === "category" && p.value !== null,
  );
  if (categoryOps.length === 0) return;
  const [proj] = await tx
    .select({ categories: projects.categories })
    .from(projects)
    .where(eq(projects.id, projectId));
  const vocabulary = proj?.categories ?? [];
  if (vocabulary.length === 0) return;
  for (const op of categoryOps) {
    if (!vocabulary.includes(op.value as string))
      throw new UnknownCategoryError(op.value as string, vocabulary);
  }
}

/**
 * Dispatch one prepared op: text/row edits accumulate in memory, collection and
 * prUrl ops write child tables immediately and yield their event + label.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param projectId - Owning project id.
 * @param userId - Caller id.
 * @param acc - Edit accumulator for text/scalar folds.
 * @param prep - Prepared op.
 * @returns The op's event, applied label, and refetch flag.
 */
async function applyPreparedOp(
  tx: Tx,
  taskId: string,
  projectId: string,
  userId: string,
  acc: EditAccumulator,
  prep: PreparedOp,
): Promise<CollectionOutcome> {
  switch (prep.kind) {
    case "text":
      applyTextOp(acc, prep.op);
      return {
        event: null,
        applied: `${prep.op.t} ${prep.op.field}`,
        refetch: false,
      };
    case "row":
      acc.rowChanges[prep.field] = prep.value;
      if (prep.field === "status") acc.statusSet = true;
      return { event: null, applied: `set ${prep.field}`, refetch: false };
    case "prUrl":
      return {
        event: await applyPrUrlTx(
          tx,
          taskId,
          projectId,
          prep.classified,
          userId,
        ),
        applied: "set prUrl",
        refetch: false,
      };
    case "criteria":
      return applyCriteria(tx, taskId, projectId, prep.op);
    case "decision":
      return applyDecision(tx, taskId, projectId, prep.op);
    case "link":
      return applyLink(tx, taskId, projectId, prep.op, userId);
    case "assignee":
      return applyAssignee(tx, taskId, projectId, prep.op);
    case "delete":
      throw new InvalidEditOpError(
        0,
        "operations[0]: delete_task must be the only op",
      );
  }
}
