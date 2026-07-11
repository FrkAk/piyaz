/**
 * `piyaz_note` handler: the agent write-back surface over the Notes data
 * ring. The data layer (`lib/data/note.ts`) owns validation, access
 * gating, and application; this layer resolves refs, validates action
 * coherence, renders slim ref-first responses, and steers the write-back
 * flywheel through `_hints`. Governance fields (`visibility`, `locked`,
 * `agent_writable`) are absent from the schema by design; PYZ-252 layers
 * the runtime rejections.
 */

import {
  applyNoteEditOps,
  composeFeedTaskRefs,
  createNotesBatch,
  createNoteTaskLink,
  deleteNote,
  deleteNotePreview,
  getNoteFull,
  getNoteRevision,
  getNoteScalarFields,
  getNoteTreeForAgent,
  listNoteRevisions,
  moveFolder,
  moveNote,
  normalizeFolder,
  removeNoteTaskLink,
  requestShare,
  restoreNote,
  searchNotesForMcp,
  NoteShareStateError,
  type CreateNoteBatchItem,
  type DeliberateNoteTaskLinkKind,
  type LinkedNoteSlim,
  type NoteEditOp,
  type NoteFullResult,
  type NoteSummary,
  type NoteTreeRow,
} from "@/lib/data/note";
import { extractSection, listSections } from "@/lib/data/note-parse";
import { resolveTaskRefs } from "@/lib/data/resolve-ref";
import { isUuid } from "@/lib/auth/authorization";
import { untrustedContentNotice } from "@/lib/context/format";
import { budgetLines } from "@/lib/mcp/budget";
import { NOTE_FIELD_ENUM } from "@/lib/mcp/schemas";
import { asIdentifier, composeNoteRef } from "@/lib/graph/identifier";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  requireNoteId,
  requireProjectId,
  requireTaskId,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** A note field addressable by `read fields=[...]`. */
export type NoteFieldName = (typeof NOTE_FIELD_ENUM)[number];

/** One note in a `piyaz_note create` batch, feed task ids as refs. */
export type NoteCreateParam = Omit<CreateNoteBatchItem, "feedTaskIds"> & {
  feedTaskIds?: string[];
};

/** Params for piyaz_note. */
export type NoteParams = {
  action:
    | "create"
    | "read"
    | "edit"
    | "list"
    | "move"
    | "delete"
    | "restore"
    | "request_share"
    | "link"
    | "unlink"
    | "search";
  project?: string;
  note?: string;
  notes?: NoteCreateParam[];
  onDuplicate?: "skip" | "error";
  fields?: NoteFieldName[];
  heading?: string;
  revision?: number;
  operations?: NoteEditOp[];
  ifUpdatedAt?: string;
  folder?: string;
  destParent?: string;
  newLeaf?: string;
  preview?: boolean;
  task?: string;
  kind?: DeliberateNoteTaskLinkKind;
  query?: string;
  limit?: number;
};

/** Row cap for the `list` tree rendering. */
const LIST_LINE_CAP = 100;

/** Hits `search` returns at most, matching the data-layer LIMIT. */
const SEARCH_HIT_CAP = 20;

/** Refs the missing-summary hint names inline before eliding the rest. */
const SUMMARY_HINT_REF_CAP = 5;

/**
 * Compose the noteRef for any summary-shaped row.
 *
 * @param row - Row carrying the ref parts.
 * @returns Composed noteRef (e.g. `DLK-N12`).
 */
function refOf(row: {
  projectIdentifier: string;
  sequenceNumber: number;
}): string {
  return composeNoteRef(
    asIdentifier(row.projectIdentifier),
    row.sequenceNumber,
  );
}

/**
 * Resolve the `note` param, scoping slug lookups by the `project` param.
 *
 * @param ctx - Resolved auth context.
 * @param p - Note params.
 * @returns The note UUID.
 */
async function resolveNoteParam(
  ctx: AuthContext,
  p: NoteParams,
): Promise<string> {
  const projectId =
    p.project === undefined
      ? undefined
      : await requireProjectId(ctx, p.project);
  return requireNoteId(ctx, p.note as string, projectId);
}

/**
 * Resolve feed task refs (`DLK-42`) to UUIDs across create items or edit
 * op values. UUIDs pass through; an unresolved ref fails the whole call.
 *
 * @param ctx - Resolved auth context.
 * @param refs - Mixed refs and UUIDs.
 * @returns UUIDs in input order, or the corrective failure message.
 */
async function resolveFeedTaskRefs(
  ctx: AuthContext,
  refs: string[],
): Promise<{ ids: string[] } | { error: string }> {
  const resolved = await resolveTaskRefs(ctx, refs);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const hit = resolved.get(ref);
    if (hit) ids.push(hit.taskId);
    else missing.push(ref);
  }
  if (missing.length > 0) {
    return {
      error: `feedTaskIds contains unresolved task ref(s): ${missing.join(", ")}. Fix or drop them and retry; no writes happened.`,
    };
  }
  return { ids };
}

/**
 * Render one tree/search row as a dense ref-first line.
 *
 * @param row - Slim tree row.
 * @param identifier - Owning project identifier.
 * @returns One markdown list line.
 */
function noteLine(row: NoteTreeRow, identifier: string): string {
  const ref = composeNoteRef(asIdentifier(identifier), row.sequenceNumber);
  const flags = [
    row.visibility === "private" ? "private" : null,
    row.feedMode !== "none" ? `feed=${row.feedMode}` : null,
    row.locked ? "locked" : null,
    row.agentWritable ? null : "agent-read-only",
  ].filter(Boolean);
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  const summary = row.summary === "" ? "" : ` — ${row.summary}`;
  return `- \`${ref}\` "${row.title}" [${row.type}]${suffix}${summary}`;
}

/**
 * Build the hint naming notes that render without a summary. A summary-less
 * note renders as a bare ref and title, so an agent cannot triage the hit
 * without opening the body, and a reference or knowledge note feeds tasks as
 * a title-only pointer.
 *
 * @param rows - Note rows carried by the response.
 * @param identifier - Project identifier scoping the composed refs.
 * @returns Hint text, or null when every row carries a summary.
 */
function missingSummaryHint(
  rows: NoteTreeRow[],
  identifier: string,
): string | null {
  const missing = rows.filter((row) => row.summary === "");
  if (missing.length === 0) return null;
  const named = missing
    .slice(0, SUMMARY_HINT_REF_CAP)
    .map((row) => composeNoteRef(asIdentifier(identifier), row.sequenceNumber));
  const elided = missing.length - named.length;
  const refs =
    elided > 0 ? `${named.join(", ")}, +${elided} more` : named.join(", ");
  return `${missing.length} note(s) have no summary (${refs}); summaries ride tree lists, search hits, and feed pointers. Set one with edit op='set' field='summary'.`;
}

/**
 * Render linked notes as ref-first lines.
 *
 * @param rows - Linked-note rows.
 * @param identifier - Owning project identifier.
 * @returns Markdown list lines.
 */
function linkedNoteLines(rows: LinkedNoteSlim[], identifier: string): string[] {
  return rows.map(
    (row) =>
      `- \`${composeNoteRef(asIdentifier(identifier), row.sequenceNumber)}\` "${row.title}" [${row.type}]`,
  );
}

/**
 * Render the raw value of one addressable field. `feedTaskRefs` maps the
 * note's feed task UUIDs to taskRefs so `feedTaskIds` renders ref-first.
 *
 * @param field - Requested field.
 * @param full - Full note read.
 * @param feedTaskRefs - Task UUID to taskRef map for `feedTaskIds`.
 * @returns Markdown lines for the field.
 */
function renderNoteField(
  field: NoteFieldName,
  full: NoteFullResult,
  feedTaskRefs: Map<string, string>,
): string[] {
  const { note, projectIdentifier } = full;
  switch (field) {
    case "body":
      return ["## body", "", note.body];
    case "links":
      return [
        "## links",
        `mentions (${full.mentions.length}):`,
        ...full.mentions.map(
          (m) => `- \`${m.taskRef}\` "${m.title}" [${m.kind}|${m.status}]`,
        ),
        `linksOut (${full.linksOut.length}):`,
        ...linkedNoteLines(full.linksOut, projectIdentifier),
        `linksIn (${full.linksIn.length}):`,
        ...linkedNoteLines(full.linksIn, projectIdentifier),
      ];
    case "feedTaskIds": {
      const refs = note.feedTaskIds.map((id) => feedTaskRefs.get(id) ?? id);
      return [`feedTaskIds: ${JSON.stringify(refs)}`];
    }
    case "title":
    case "summary":
    case "folder":
    case "type":
    case "visibility":
    case "feedMode":
    case "category":
    case "feedCategories":
    case "feedTags":
    case "tags":
      return [`${field}: ${JSON.stringify(note[field])}`];
    case "agentWritable":
      return [`agentWritable: ${note.agentWritable}`];
    case "locked":
      return [`locked: ${note.locked}`];
    case "revisions":
      return [];
  }
}

/**
 * Render the default meta header for one note.
 *
 * @param full - Full note read.
 * @returns Markdown text.
 */
function renderNoteMeta(full: NoteFullResult): string {
  const { note, projectIdentifier } = full;
  const ref = composeNoteRef(
    asIdentifier(projectIdentifier),
    note.sequenceNumber,
  );
  const feed =
    note.feedMode === "none"
      ? "none (searchable, never auto-injected)"
      : note.feedMode === "categories"
        ? `categories [${note.feedCategories.join(", ")}]`
        : note.feedMode === "tags"
          ? `tags [${note.feedTags.join(", ")}]`
          : note.feedMode === "tasks"
            ? `tasks (${note.feedTaskIds.length})`
            : "all";
  const sections = listSections(note.body);
  const lines = [
    untrustedContentNotice("working"),
    "",
    `# \`${ref}\` "${note.title}" [${note.type}]`,
    `slug: ${note.slug} | folder: ${note.folder === "" ? "(root)" : note.folder} | visibility: ${note.visibility} | feed: ${feed}`,
    `version: ${note.version} | locked: ${note.locked} | agentWritable: ${note.agentWritable}${note.shareRequestedBy ? " | share request pending" : ""}`,
    `updatedAt: ${note.updatedAt.toISOString()} (pass as ifUpdatedAt on piyaz_note edit for a compare-and-swap)`,
  ];
  if (note.summary !== "") lines.push("", note.summary);
  if (sections.length > 0) {
    lines.push(
      "",
      `Sections (read one via heading='...'): ${sections.map((s) => s.text).join(" | ")}`,
    );
  }
  if (full.mentions.length > 0) {
    lines.push(
      "",
      `Mentions (${full.mentions.length}):`,
      ...full.mentions.map(
        (m) => `- \`${m.taskRef}\` "${m.title}" [${m.kind}|${m.status}]`,
      ),
    );
  }
  if (full.linksOut.length > 0) {
    lines.push(
      "",
      `Links out (${full.linksOut.length}):`,
      ...linkedNoteLines(full.linksOut, projectIdentifier),
    );
  }
  if (full.linksIn.length > 0) {
    lines.push(
      "",
      `Backlinks (${full.linksIn.length}):`,
      ...linkedNoteLines(full.linksIn, projectIdentifier),
    );
  }
  return lines.join("\n");
}

/**
 * Handle the `create` action: 1-10 notes, idempotent by (folder, title).
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with refs for created and deduped notes.
 */
async function handleCreate(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  if (!p.project || !p.notes || p.notes.length === 0) {
    return fail(
      "create requires project ('DLK' or UUID) and notes=[...] (1-10 items with at least a title).",
    );
  }
  const projectId = await requireProjectId(ctx, p.project);

  const allFeedRefs = p.notes.flatMap((n) => n.feedTaskIds ?? []);
  const pendingRefs = allFeedRefs.filter((r) => !isUuid(r));
  let refMap = new Map<string, string>();
  if (pendingRefs.length > 0) {
    const resolved = await resolveFeedTaskRefs(ctx, allFeedRefs);
    if ("error" in resolved) return fail(resolved.error);
    refMap = new Map(allFeedRefs.map((r, i) => [r, resolved.ids[i]]));
  }
  const items: CreateNoteBatchItem[] = p.notes.map((n) => ({
    ...n,
    feedTaskIds: n.feedTaskIds?.map((r) => refMap.get(r) ?? r),
  }));

  const result = await createNotesBatch(ctx, projectId, items, {
    visibility: "team",
    onDuplicate: p.onDuplicate,
  });

  const hints: string[] = [];
  const createdKey = (folder: string, title: string) => `${folder} ${title}`;
  const createdKeys = new Set(
    result.created.map((s) => createdKey(s.folder, s.title)),
  );
  const createdInputs = p.notes.filter((n) =>
    createdKeys.has(createdKey(normalizeFolder(n.folder ?? ""), n.title)),
  );
  const fedItems = createdInputs.filter(
    (n) => n.feedMode !== undefined && n.feedMode !== "none",
  ).length;
  if (createdInputs.length > 0 && fedItems === 0) {
    hints.push(
      "Created team-visible: teammates' agents can search these now. Nothing auto-injects into task bundles until feedMode is set (edit set feedMode='categories'/'tags'/'tasks'/'all').",
    );
  }
  const missingSummaries = createdInputs.filter(
    (n) => n.summary === undefined || n.summary === "",
  ).length;
  if (missingSummaries > 0) {
    hints.push(
      `${missingSummaries} note(s) have no summary; summaries ride tree lists, search hits, and feed pointers — set them via edit.`,
    );
  }
  if (result.deduped.length > 0) {
    hints.push(
      `${result.deduped.length} item(s) deduped by exact (folder, title); the returned refs point at the existing notes. Use edit to change them.`,
    );
  }

  const slim = (s: NoteSummary) => ({
    ref: refOf(s),
    title: s.title,
    folder: s.folder,
    slug: s.slug,
  });
  return ok({
    created: result.created.map(slim),
    deduped: result.deduped.map(slim),
    ...(hints.length > 0 && { _hints: hints }),
  });
}

/**
 * Handle the `read` action across its shapes: meta, fields, heading
 * section, revision list, and revision snapshot.
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
async function handleRead(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  const noteId = await resolveNoteParam(ctx, p);

  if (p.revision !== undefined) {
    const result = await getNoteRevision(ctx, noteId, p.revision);
    const ref = refOf(result);
    if (result.snapshot === null) {
      return fail(
        `\`${ref}\` has no revision ${p.revision}. Available versions: ${
          result.availableVersions.length > 0
            ? result.availableVersions.join(", ")
            : "none (revisions snapshot on body changes)"
        }.`,
      );
    }
    return ok(
      [
        untrustedContentNotice("working"),
        "",
        `# \`${ref}\` revision ${result.snapshot.version}`,
        `title: ${JSON.stringify(result.snapshot.title)} | createdAt: ${result.snapshot.createdAt.toISOString()}`,
        "",
        result.snapshot.body,
        "",
        "_To restore this body: piyaz_note edit with one op {op:'set', field:'body', text:<this body>}._",
      ].join("\n"),
    );
  }

  if (p.heading !== undefined && (p.fields?.length ?? 0) > 0) {
    return fail(
      "read takes either heading='...' (one section) or fields=[...] (field values), not both. Call read twice.",
    );
  }

  const wantsRevisions = p.fields?.includes("revisions") ?? false;
  const otherFields = (p.fields ?? []).filter((f) => f !== "revisions");

  if (wantsRevisions && otherFields.length === 0 && p.heading === undefined) {
    const rev = await listNoteRevisions(ctx, noteId);
    return ok(
      [
        `# \`${refOf(rev)}\` revisions (live version ${rev.currentVersion})`,
        ...rev.revisions.map(
          (r) => `- v${r.version} "${r.title}" ${r.createdAt.toISOString()}`,
        ),
        "Read one via revision=<version>.",
      ].join("\n"),
    );
  }

  if (p.heading !== undefined) {
    const full = await getNoteFull(ctx, noteId);
    const ref = refOf({
      projectIdentifier: full.projectIdentifier,
      sequenceNumber: full.note.sequenceNumber,
    });
    const section = extractSection(full.note.body, p.heading);
    if (section === null) {
      const available = listSections(full.note.body);
      return fail(
        available.length > 0
          ? `No heading "${p.heading}" in \`${ref}\`. Available: ${available.map((s) => s.text).join(" | ")}.`
          : `\`${ref}\` has no markdown headings; read fields=['body'] instead.`,
      );
    }
    return ok(
      [
        untrustedContentNotice("working"),
        "",
        `# \`${ref}\` section "${p.heading}"`,
        `updatedAt: ${full.note.updatedAt.toISOString()} (pass as ifUpdatedAt on piyaz_note edit)`,
        "",
        section,
      ].join("\n"),
    );
  }

  if (otherFields.length > 0) {
    const needsFull = otherFields.some((f) => f === "body" || f === "links");
    const [full, revisions] = await Promise.all([
      needsFull ? getNoteFull(ctx, noteId) : getNoteScalarFields(ctx, noteId),
      wantsRevisions ? listNoteRevisions(ctx, noteId) : Promise.resolve(null),
    ]);
    const ref = refOf({
      projectIdentifier: full.projectIdentifier,
      sequenceNumber: full.note.sequenceNumber,
    });
    const feedTaskRefs =
      otherFields.includes("feedTaskIds") && full.note.feedTaskIds.length > 0
        ? await composeFeedTaskRefs(ctx, full.note.feedTaskIds)
        : new Map<string, string>();
    const parts: string[] = [
      untrustedContentNotice("working"),
      "",
      `# \`${ref}\` fields`,
      `updatedAt: ${full.note.updatedAt.toISOString()} (pass as ifUpdatedAt on piyaz_note edit for a compare-and-swap)`,
    ];
    for (const field of otherFields) {
      parts.push("", ...renderNoteField(field, full, feedTaskRefs));
    }
    if (revisions) {
      parts.push(
        "",
        "## revisions",
        ...revisions.revisions.map(
          (r) => `- v${r.version} "${r.title}" ${r.createdAt.toISOString()}`,
        ),
      );
    }
    const hints: string[] = [];
    if (otherFields.includes("body")) {
      const sections = listSections(full.note.body);
      if (sections.length > 1) {
        hints.push(
          `This body has ${sections.length} sections; next time read heading='...' for just the one you need.`,
        );
      }
    }
    return ok(
      hints.length > 0
        ? { text: parts.join("\n"), _hints: hints }
        : parts.join("\n"),
    );
  }

  const full = await getNoteFull(ctx, noteId);
  return ok(renderNoteMeta(full));
}

/**
 * Handle the `edit` action: ordered atomic ops via the shared engine.
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with applied labels and the fresh CAS token.
 */
async function handleEditAction(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  if (!p.operations || p.operations.length === 0) {
    return fail("edit requires operations=[...] (1-20 ordered ops).");
  }
  const noteId = await resolveNoteParam(ctx, p);

  const ops: NoteEditOp[] = [];
  for (const op of p.operations) {
    if (op.field === "feedTaskIds" && Array.isArray(op.value)) {
      const values = op.value as string[];
      if (values.some((v) => typeof v === "string" && !isUuid(v))) {
        const resolved = await resolveFeedTaskRefs(ctx, values);
        if ("error" in resolved) return fail(resolved.error);
        ops.push({ ...op, value: resolved.ids });
        continue;
      }
    }
    ops.push(op);
  }

  const result = await applyNoteEditOps(ctx, noteId, ops, p.ifUpdatedAt);

  const hints: string[] = [];
  if (result.links) {
    hints.push(
      `Body links re-derived: ${result.links.mentions.length} task mention(s), ${result.links.linksOut.length} note link(s).`,
    );
  }
  const feedModeOp = [...ops]
    .reverse()
    .find((op) => op.field === "feedMode" && op.op === "set");
  if (feedModeOp) {
    const mode = feedModeOp.value ?? feedModeOp.text;
    const armField =
      mode === "categories"
        ? "feedCategories"
        : mode === "tags"
          ? "feedTags"
          : mode === "tasks"
            ? "feedTaskIds"
            : null;
    if (armField && !ops.some((op) => op.field === armField)) {
      hints.push(
        `feedMode='${String(mode)}' matches via ${armField}; if that list is empty the note never injects. Set it in the same edit next time.`,
      );
    }
  }

  return ok({
    ref: refOf(result),
    applied: ops.map((op) => `${op.op} ${op.field}`),
    version: result.version,
    updatedAt: result.updatedAt.toISOString(),
    ...(hints.length > 0 && { _hints: hints }),
  });
}

/**
 * Handle the `list` action: the folder tree agents and humans share.
 * Folder headers union note-derived paths with explicit `note_folders`
 * markers, so an explicitly created folder with no notes yet still
 * renders (as a bare header) and agents can target it on create.
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with the grouped tree.
 */
async function handleList(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  if (!p.project) return fail("list requires project ('DLK' or UUID).");
  const projectId = await requireProjectId(ctx, p.project);
  const { projectIdentifier, rows, explicitFolders } =
    await getNoteTreeForAgent(ctx, projectId);
  if (rows.length === 0 && explicitFolders.length === 0) {
    return ok(
      `Project ${projectIdentifier} has no notes yet. Record durable knowledge with piyaz_note create.`,
    );
  }
  const notesByFolder = new Map<string, NoteTreeRow[]>();
  for (const row of rows) {
    const group = notesByFolder.get(row.folder);
    if (group === undefined) notesByFolder.set(row.folder, [row]);
    else group.push(row);
  }
  const folders = [
    ...new Set([...notesByFolder.keys(), ...explicitFolders]),
  ].sort();
  const lines: string[] = [];
  for (const folder of folders) {
    lines.push(folder === "" ? "(root)/" : `${folder}/`);
    for (const row of notesByFolder.get(folder) ?? []) {
      lines.push(`  ${noteLine(row, projectIdentifier)}`);
    }
  }
  const budgeted = budgetLines(
    lines,
    LIST_LINE_CAP,
    "narrow with piyaz_note action='search' query='...'",
  );
  const text = [
    `# ${projectIdentifier} notes (${rows.length})`,
    ...budgeted.lines,
  ];
  const summaryHint = missingSummaryHint(rows, projectIdentifier);
  if (summaryHint !== null) text.push(summaryHint);
  return ok(
    text.join("\n"),
    budgeted.truncated ? { truncated: true } : undefined,
  );
}

/**
 * Handle the `move` action: one note into a folder, or a folder subtree
 * re-parent/rename when destParent is present.
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
async function handleMove(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  if (p.destParent !== undefined) {
    if (!p.project || p.folder === undefined) {
      return fail(
        "Folder move requires project, folder (the source path), and destParent ('' = root); newLeaf renames.",
      );
    }
    const projectId = await requireProjectId(ctx, p.project);
    const result = await moveFolder(
      ctx,
      projectId,
      p.folder,
      p.destParent,
      p.newLeaf,
    );
    return ok({
      dest: result.dest,
      movedCount: result.movedCount,
      explicitMoved: result.explicitMoved,
      ...(result.movedCount === 0 &&
        result.explicitMoved === 0 && {
          _hints: [
            "Nothing moved: no live notes and no explicit folder markers under that source path. Check the path with piyaz_note action='list'.",
          ],
        }),
    });
  }
  if (!p.note || p.folder === undefined) {
    return fail(
      "move requires note plus folder (the destination path, '' = root), or folder+destParent for a folder-subtree move.",
    );
  }
  const noteId = await resolveNoteParam(ctx, p);
  const summary = await moveNote(ctx, noteId, p.folder);
  return ok({
    ref: refOf(summary),
    folder: summary.folder,
    updatedAt: summary.updatedAt.toISOString(),
  });
}

/**
 * Handle the `delete` action: preview by default, then soft delete.
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
async function handleDelete(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  const noteId = await resolveNoteParam(ctx, p);
  if (p.preview !== false) {
    const preview = await deleteNotePreview(ctx, noteId);
    return ok({
      preview,
      _hints: [
        "Preview only. Deleting trashes the note (restore recovers it), drops it from every tree, search, and feed, and frees its slug. Re-run with preview=false to execute.",
      ],
    });
  }
  const result = await deleteNote(ctx, noteId);
  return ok({
    id: result.id,
    ref: refOf(result),
    deletedAt: result.deletedAt.toISOString(),
    _hints: [
      `Soft-deleted. A trashed note's ref no longer resolves; to recover it call piyaz_note action='restore' note='${result.id}' (the UUID).`,
    ],
  });
}

/**
 * Handle the `link`/`unlink` actions: deliberate note-task relations.
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @param direction - Which mutation to run.
 * @returns Tool result.
 */
async function handleLink(
  p: NoteParams,
  ctx: AuthContext,
  direction: "link" | "unlink",
): Promise<ToolResult> {
  if (!p.note || !p.task || !p.kind) {
    return fail(
      `${direction} requires note, task ('DLK-42' or UUID), and kind ('reference' or 'spec_of'). mention rows derive from [[refs]] in the body.`,
    );
  }
  const noteId = await resolveNoteParam(ctx, p);
  const taskId = await requireTaskId(ctx, p.task);
  if (direction === "link") {
    const result = await createNoteTaskLink(ctx, noteId, taskId, p.kind);
    return ok({
      ref: refOf(result),
      task: p.task,
      kind: p.kind,
      created: result.created,
      ...(!result.created && {
        _hints: ["The link already exists. Treat as success."],
      }),
      ...(result.created &&
        p.kind === "spec_of" && {
          _hints: [
            "spec_of recorded: this note is the task's spec. It surfaces under Relevant Notes when an agent reads the task (piyaz_get lens='agent'/'planning'), which reads the note for detail. Keep it current as the task evolves.",
          ],
        }),
    });
  }
  const result = await removeNoteTaskLink(ctx, noteId, taskId, p.kind);
  return ok({
    ref: refOf(result),
    task: p.task,
    kind: p.kind,
    removed: result.removed,
    ...(!result.removed && {
      _hints: [
        "No such link existed; nothing removed. mention rows derive from the body and clear when the [[ref]] is edited out.",
      ],
    }),
  });
}

/**
 * Handle the `search` action: a full noteRef ('DLK-N12') short-circuits to
 * exact note resolution; otherwise RLS-scoped ranked full text in one project.
 *
 * @param p - Note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
async function handleSearch(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  if (!p.project || p.query === undefined) {
    return fail("search requires project ('DLK' or UUID) and query.");
  }
  const projectId = await requireProjectId(ctx, p.project);
  const { projectIdentifier, hits } = await searchNotesForMcp(
    ctx,
    projectId,
    p.query,
  );
  const limited = hits.slice(
    0,
    Math.min(p.limit ?? SEARCH_HIT_CAP, SEARCH_HIT_CAP),
  );
  if (limited.length === 0) {
    return ok(
      `No notes match "${p.query}" in ${projectIdentifier}. Team notes and your own private notes are searchable regardless of feed mode; try action='list' for the full tree.`,
    );
  }
  const lines = limited.map((row) => {
    const folder = row.folder === "" ? "" : ` (${row.folder}/)`;
    return `${noteLine(row, projectIdentifier)}${folder}`;
  });
  const hints = [
    "Chain a ref into piyaz_note action='read' (meta lists the sections; heading='...' reads one) instead of pulling full bodies.",
  ];
  const summaryHint = missingSummaryHint(limited, projectIdentifier);
  if (summaryHint !== null) hints.push(summaryHint);
  return ok({
    text: [
      `# ${projectIdentifier} note search: "${p.query}" (${limited.length} hit${limited.length === 1 ? "" : "s"})`,
      ...lines,
    ].join("\n"),
    _hints: hints,
  });
}

/**
 * Handle piyaz_note.
 *
 * @param p - Validated note params.
 * @param ctx - Resolved auth context.
 * @returns Tool result.
 */
export async function handleNote(
  p: NoteParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    switch (p.action) {
      case "create":
        return await handleCreate(p, ctx);
      case "read":
        if (!p.note) {
          return fail(
            "read requires note ('DLK-N12', UUID, or slug with project).",
          );
        }
        return await handleRead(p, ctx);
      case "edit":
        if (!p.note) {
          return fail(
            "edit requires note ('DLK-N12', UUID, or slug with project).",
          );
        }
        return await handleEditAction(p, ctx);
      case "list":
        return await handleList(p, ctx);
      case "move":
        return await handleMove(p, ctx);
      case "delete":
        if (!p.note) return fail("delete requires note.");
        return await handleDelete(p, ctx);
      case "restore": {
        if (!p.note) {
          return fail(
            "restore requires note (the UUID from the delete response; a trashed note's ref does not resolve).",
          );
        }
        const noteId = await resolveNoteParam(ctx, p);
        const summary = await restoreNote(ctx, noteId);
        return ok({
          ref: refOf(summary),
          slug: summary.slug,
          folder: summary.folder,
          updatedAt: summary.updatedAt.toISOString(),
        });
      }
      case "request_share": {
        if (!p.note) return fail("request_share requires note.");
        const noteId = await resolveNoteParam(ctx, p);
        try {
          const summary = await requestShare(ctx, noteId);
          return ok({
            ref: refOf(summary),
            _hints: [
              "Share request recorded; a human approves or declines in the web UI. The note stays private (invisible to teammates and their agents) until approved.",
            ],
          });
        } catch (e) {
          if (e instanceof NoteShareStateError && e.reason === "already_team") {
            return ok({
              note: p.note,
              alreadyTeam: true,
              _hints: [
                "Note is already visible to the team; no share request is needed. Teammates' agents can already see it.",
              ],
            });
          }
          throw e;
        }
      }
      case "link":
      case "unlink":
        return await handleLink(p, ctx, p.action);
      case "search":
        return await handleSearch(p, ctx);
    }
  } catch (e) {
    return translateError(e);
  }
}
