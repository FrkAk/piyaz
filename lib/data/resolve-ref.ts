import "server-only";

import { normalizeExecuteResult } from "@/lib/db/raw";
import {
  projectRefLookupStmt,
  taskRefLookupStmt,
  taskRefNearMissStmt,
  type NearMissRow,
  type ProjectRefRow,
  type TaskRefRow,
} from "@/lib/db/raw/resolve-ref-lookup";
import { withUserContextRead } from "@/lib/db/rls";
import { isUuid } from "@/lib/auth/authorization";
import {
  asIdentifier,
  composeTaskRef,
  parseIdentifier,
} from "@/lib/graph/identifier";
import { TASK_REF_PATTERN } from "@/lib/data/task";
import type { AuthContext } from "@/lib/auth/context";

/** Largest value the `tasks.sequence_number` int4 column can hold. */
const INT4_MAX = 2_147_483_647;

/** A resolvable ref matched in more than one of the caller's teams. */
export type RefCandidate = {
  /** Task id — set for task-ref candidates, undefined for project refs. */
  taskId?: string;
  /** Owning project id. */
  projectId: string;
  /** Owning project title. */
  projectTitle: string;
  /** Owning team name. */
  teamName: string;
};

/** A resolved task ref or passed-through task UUID. */
export type ResolvedTaskRef = {
  /** Task UUID. */
  taskId: string;
  /** Owning project id — set only when a ref was resolved, not on passthrough. */
  projectId?: string;
  /** Composed taskRef — set only when a ref was resolved. */
  taskRef?: string;
};

/** A resolved project identifier or passed-through project UUID. */
export type ResolvedProjectRef = {
  /** Project UUID. */
  projectId: string;
  /** Project identifier — set only when a ref was resolved, not on passthrough. */
  identifier?: string;
  /** Owning team id — set only when a ref was resolved. */
  organizationId?: string;
};

/** Thrown when a ref matches rows in more than one team the caller belongs to. */
export class RefAmbiguityError extends Error {
  /**
   * @param ref - The ambiguous ref, normalized.
   * @param candidates - One entry per matching team.
   */
  constructor(
    public readonly ref: string,
    public readonly candidates: RefCandidate[],
  ) {
    super(`Ref '${ref}' matches ${candidates.length} teams`);
    this.name = "RefAmbiguityError";
  }
}

/** Thrown when input is neither a UUID nor a valid ref shape. */
export class MalformedRefError extends Error {
  /**
   * @param input - The rejected input string.
   */
  constructor(public readonly input: string) {
    super(`'${input}' is not a taskRef or UUID`);
    this.name = "MalformedRefError";
  }
}

/** One visible project matching a near-missed ref's prefix. */
export type NearMissProject = {
  /** Project identifier (the ref's prefix). */
  identifier: string;
  /** Owning team name, disambiguating same-identifier projects. */
  teamName: string;
  /** Highest task sequence number, or null for a project with no tasks. */
  maxSequenceNumber: number | null;
};

/**
 * Thrown when a ref does not resolve. 404-shaped; carries near-miss info
 * only when the project prefix IS visible to the caller, so a caller cannot
 * distinguish "project exists in a team I do not belong to" from "does not
 * exist".
 */
export class RefNotFoundError extends Error {
  /**
   * @param ref - The unresolved ref, normalized.
   * @param projectIdentifier - Set when the prefix resolved to a visible project.
   * @param maxSequenceNumber - Set when the visible project has tasks; the
   *   highest sequence number, for near-miss copy.
   * @param nearMisses - One row per visible project with the prefix; more
   *   than one when the caller's teams share an identifier.
   */
  constructor(
    public readonly ref: string,
    public readonly projectIdentifier?: string,
    public readonly maxSequenceNumber?: number,
    public readonly nearMisses: NearMissProject[] = [],
  ) {
    super(`Ref '${ref}' not found`);
    this.name = "RefNotFoundError";
  }
}

/**
 * Match the taskRef shape and uppercase the prefix. Does not validate the
 * sequence number range; see {@link seqInRange}.
 *
 * @param input - Candidate ref string.
 * @returns The uppercase prefix and raw sequence text, or null when the
 *   input is not ref-shaped.
 */
function matchTaskRef(
  input: string,
): { prefix: string; seqText: string } | null {
  const m = input.match(TASK_REF_PATTERN);
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), seqText: m[2] };
}

/**
 * Parse a sequence number and bound it to the int4 column range.
 *
 * @param seqText - Digit string from a ref match.
 * @returns The sequence number, or null when it cannot be a valid task
 *   sequence (out of int4 range) so the lookup can be skipped safely.
 */
function seqInRange(seqText: string): number | null {
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > INT4_MAX) return null;
  return seq;
}

/**
 * Project a task-ref row to a resolved result.
 *
 * @param row - Lookup row.
 * @returns Resolved task ref.
 */
function toResolvedTask(row: TaskRefRow): ResolvedTaskRef {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    taskRef: composeTaskRef(asIdentifier(row.identifier), row.sequence_number),
  };
}

/**
 * Project a task-ref row to an ambiguity candidate.
 *
 * @param row - Lookup row.
 * @returns Candidate with taskId set.
 */
function toTaskCandidate(row: TaskRefRow): RefCandidate {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    teamName: row.team_name,
  };
}

/**
 * Project a project-ref row to an ambiguity candidate.
 *
 * @param row - Lookup row.
 * @returns Candidate without a taskId.
 */
function toProjectCandidate(row: ProjectRefRow): RefCandidate {
  return {
    projectId: row.project_id,
    projectTitle: row.project_title,
    teamName: row.team_name,
  };
}

/**
 * Resolve a task ref (`PYZ-42`) or task UUID to a task id, org-bounded and
 * read-only. A UUID passes through WITHOUT any query — `projectId`/`taskRef`
 * stay undefined and the downstream access assertion happens at the call
 * site exactly as it does today. A ref is matched case-insensitively against
 * visible projects.
 *
 * @param ctx - Resolved auth context.
 * @param refOrId - A taskRef like `PYZ-42` or a task UUID.
 * @returns The task id, plus projectId and taskRef when a ref was resolved.
 * @throws MalformedRefError when the input is neither a UUID nor ref-shaped.
 * @throws RefAmbiguityError when the ref matches two of the caller's teams.
 * @throws RefNotFoundError when the ref does not resolve.
 */
export async function resolveTaskRef(
  ctx: AuthContext,
  refOrId: string,
): Promise<ResolvedTaskRef> {
  if (isUuid(refOrId)) return { taskId: refOrId };

  const match = matchTaskRef(refOrId);
  if (!match) throw new MalformedRefError(refOrId);

  const seq = seqInRange(match.seqText);

  const [candidatesRaw, nearMissRaw] = await withUserContextRead(
    ctx.userId,
    (read) => [
      taskRefLookupStmt(
        read,
        seq === null ? [] : [{ prefix: match.prefix, seqs: [seq] }],
      ),
      taskRefNearMissStmt(read, match.prefix),
    ],
  );
  const candidates = normalizeExecuteResult<TaskRefRow>(candidatesRaw);

  if (candidates.length === 1) return toResolvedTask(candidates[0]);
  if (candidates.length > 1) {
    throw new RefAmbiguityError(refOrId, candidates.map(toTaskCandidate));
  }

  const nearMissRows = normalizeExecuteResult<NearMissRow>(nearMissRaw);
  if (nearMissRows.length > 0) {
    const [first] = nearMissRows;
    throw new RefNotFoundError(
      refOrId,
      first.identifier,
      first.max_sequence_number ?? undefined,
      nearMissRows.map((r) => ({
        identifier: r.identifier,
        teamName: r.team_name,
        maxSequenceNumber: r.max_sequence_number,
      })),
    );
  }
  throw new RefNotFoundError(refOrId);
}

/**
 * Batch variant of {@link resolveTaskRef}. Resolves every ref-shaped input
 * in ONE query (grouped by prefix); UUID inputs pass through. Map keys are
 * the original input strings.
 *
 * Fails fast with {@link MalformedRefError} on the first input that is
 * neither a UUID nor ref-shaped. Refs that are ambiguous or unresolved are
 * omitted from the map (the caller derives the missing set and can call
 * {@link resolveTaskRef} for the rich per-ref error).
 *
 * @param ctx - Resolved auth context.
 * @param refsOrIds - Task refs and/or UUIDs.
 * @returns Map from each resolvable input to its resolution.
 * @throws MalformedRefError when any input is neither a UUID nor ref-shaped.
 */
export async function resolveTaskRefs(
  ctx: AuthContext,
  refsOrIds: string[],
): Promise<Map<string, ResolvedTaskRef>> {
  const result = new Map<string, ResolvedTaskRef>();
  const groups = new Map<string, Set<number>>();
  const refInputs: { input: string; key: string }[] = [];

  for (const input of refsOrIds) {
    if (isUuid(input)) {
      result.set(input, { taskId: input });
      continue;
    }
    const match = matchTaskRef(input);
    if (!match) throw new MalformedRefError(input);
    const seq = seqInRange(match.seqText);
    if (seq === null) continue;
    refInputs.push({ input, key: `${match.prefix}-${seq}` });
    const seqs = groups.get(match.prefix) ?? new Set<number>();
    seqs.add(seq);
    groups.set(match.prefix, seqs);
  }

  if (groups.size === 0) return result;

  const [rowsRaw] = await withUserContextRead(ctx.userId, (read) => [
    taskRefLookupStmt(
      read,
      [...groups].map(([prefix, seqs]) => ({ prefix, seqs: [...seqs] })),
    ),
  ]);
  const rows = normalizeExecuteResult<TaskRefRow>(rowsRaw);

  const byKey = new Map<string, TaskRefRow[]>();
  for (const row of rows) {
    const key = `${row.identifier}-${row.sequence_number}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(row);
    byKey.set(key, bucket);
  }

  for (const { input, key } of refInputs) {
    const bucket = byKey.get(key);
    if (bucket && bucket.length === 1)
      result.set(input, toResolvedTask(bucket[0]));
  }

  return result;
}

/**
 * Resolve a project identifier (`PYZ`) or project UUID to a project id,
 * org-bounded and read-only. A UUID passes through WITHOUT any query —
 * `identifier`/`organizationId` stay undefined and the downstream access
 * assertion happens at the call site exactly as it does today. The
 * identifier is uppercased before matching.
 *
 * @param ctx - Resolved auth context.
 * @param identifierOrId - A project identifier like `PYZ` or a project UUID.
 * @returns The project id, plus identifier and organizationId when a ref
 *   was resolved.
 * @throws MalformedRefError when the input is neither a UUID nor a valid
 *   identifier shape.
 * @throws RefAmbiguityError when the identifier matches two of the caller's
 *   teams.
 * @throws RefNotFoundError when the identifier does not resolve.
 */
export async function resolveProjectRef(
  ctx: AuthContext,
  identifierOrId: string,
): Promise<ResolvedProjectRef> {
  if (isUuid(identifierOrId)) return { projectId: identifierOrId };

  const parsed = parseIdentifier(identifierOrId.toUpperCase());
  if (!parsed.ok) throw new MalformedRefError(identifierOrId);

  const [rowsRaw] = await withUserContextRead(ctx.userId, (read) => [
    projectRefLookupStmt(read, parsed.value),
  ]);
  const rows = normalizeExecuteResult<ProjectRefRow>(rowsRaw);
  if (rows.length === 1) {
    const row = rows[0];
    return {
      projectId: row.project_id,
      identifier: row.identifier,
      organizationId: row.organization_id,
    };
  }
  if (rows.length > 1) {
    throw new RefAmbiguityError(parsed.value, rows.map(toProjectCandidate));
  }
  throw new RefNotFoundError(parsed.value);
}
