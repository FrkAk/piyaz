# Organization Workspace Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let organization owners download a complete, privacy-scoped workspace archive and restore it as a new organization on another Piyaz deployment.

**Architecture:** A strict, versioned JSON contract separates portable data from database rows. Dedicated route handlers authorize and bound file transfer, a data module reads and writes every workspace table under RLS, and import creates a new Better Auth organization before restoring all workspace rows transactionally with fresh ids.

**Tech Stack:** Next.js 16 Route Handlers, TypeScript 6, Zod 4, Drizzle ORM, PostgreSQL RLS, Better Auth 1.6, React 19, Bun test, Biome, ESLint.

**Spec:** `docs/superpowers/specs/2026-08-24-organization-workspace-portability-design.md`

## Global Constraints

- Keep the existing personal account export unchanged.
- Export is allowed only when the caller owns the named organization.
- Read workspace data only through the caller's RLS context; ownership never bypasses private-note visibility.
- Import always creates a new organization owned by the importing user and never merges into existing data.
- Preserve workspace timestamps, activity events, note revisions, and internal relationships while generating fresh destination ids.
- Include no member profiles, invitations, credentials, legal records, other-member assignments, OAuth client ids, or hidden private-note data.
- Map exporter-owned user references to the importing user and leave other nullable attribution absent.
- Accept at most 100 MiB and 500,000 total archive rows.
- Use the existing organization-creation path so DPA evidence and owned-organization limits remain enforced.
- Add no dependency and no database migration.
- Every new module, function, component, and route handler receives a concise structured docstring.
- Add no inline comments unless an algorithm cannot be made self-documenting.
- Use Bun for package and test commands.

---

## File Map

- Create `lib/organization-portability/archive.ts`: archive constants, strict Zod schemas, types, JSON decoding, serialized-size checks, and cross-reference validation.
- Create `lib/data/organization-portability.ts`: RLS-scoped export queries and transactional import with id remapping.
- Create `lib/organization-portability/organization-lifecycle.ts`: Better Auth create/retry and compensating delete used by the import route.
- Create `app/api/organization/[organizationId]/export/route.ts`: authenticated owner export download.
- Create `app/api/organization/import/route.ts`: bounded archive upload and new-organization restore orchestration.
- Create `app/settings/_components/team-manage/WorkspaceExportSection.tsx`: owner-facing download control.
- Create `app/settings/_components/ImportWorkspacePanel.tsx`: file, DPA consent, upload, and result UI.
- Modify `app/settings/_components/TeamManageModal.tsx`: render export for owners.
- Modify `app/settings/_components/TeamsTab.tsx`: expose and refresh after import.
- Create `tests/organization-portability/archive.test.ts`: contract and reference validation tests.
- Create `tests/data/organization-portability.test.ts`: full export, privacy, and round-trip integration tests.
- Create `tests/api/organization-portability.test.ts`: route authorization, body bounds, and orchestration tests.
- Create `tests/ui/organization-portability.test.ts`: pure UI state and filename behavior tests where DOM interaction is not required.

### Task 1: Versioned archive contract

**Files:**
- Create: `lib/organization-portability/archive.ts`
- Create: `tests/organization-portability/archive.test.ts`

**Interfaces:**
- Produces: `ORGANIZATION_ARCHIVE_MEDIA_TYPE`, `MAX_ORGANIZATION_ARCHIVE_BYTES`, `MAX_ORGANIZATION_ARCHIVE_ROWS`, `OrganizationArchive`, `OrganizationArchiveError`, `parseOrganizationArchive(raw: unknown): OrganizationArchive`, `decodeOrganizationArchive(bytes: Uint8Array): OrganizationArchive`, `serializeOrganizationArchive(archive: OrganizationArchive): string`, and `organizationArchiveFilename(slug: string): string`.
- Consumes: status, priority, estimate, activity, note, visibility, feed, and link unions from `lib/types.ts`; note byte/character caps from `lib/db/schema.ts`; team name and slug rules from `lib/team/slug-rules.ts`.

- [ ] **Step 1: Write failing archive parser tests**

Create literal fixtures without calling production builders. Cover one valid archive and separate failures for an unknown top-level key, unsupported version, duplicate source id, dangling task/project reference, cross-project task edge, cross-project note/task link, invalid timestamp, over-limit note body, over-limit aggregate row count, and malformed UTF-8/JSON.

```ts
test("rejects a dangling task project reference", () => {
  const archive = validArchive();
  archive.tasks[0] = {
    ...archive.tasks[0],
    projectSourceId: "00000000-0000-4000-8000-000000000099",
  };

  expect(() => parseOrganizationArchive(archive)).toThrow(
    "tasks[0].projectSourceId does not reference an exported project",
  );
});

test("rejects duplicate source ids across one row collection", () => {
  const archive = validArchive();
  archive.tasks.push({ ...archive.tasks[0] });

  expect(() => parseOrganizationArchive(archive)).toThrow(
    "tasks contains duplicate sourceId",
  );
});
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run: `bun test tests/organization-portability/archive.test.ts`

Expected: FAIL because `lib/organization-portability/archive.ts` does not exist.

- [ ] **Step 3: Implement the strict archive schemas and reference validator**

Define strict row schemas for all arrays in the spec. Use source-side relationship names such as `projectSourceId`, `taskSourceId`, `sourceTaskSourceId`, `targetTaskSourceId`, `noteSourceId`, `sourceNoteSourceId`, and `targetNoteSourceId`. Represent user attribution as `z.literal("exporter").nullable()` and task assignments as `{ taskSourceId, createdAt }`.

The public entry point must first parse field types and limits, then run graph validation:

```ts
export const ORGANIZATION_ARCHIVE_MEDIA_TYPE =
  "application/vnd.piyaz.organization+json";
export const MAX_ORGANIZATION_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_ORGANIZATION_ARCHIVE_ROWS = 500_000;

export class OrganizationArchiveError extends Error {
  /**
   * Create a client-safe archive validation error.
   *
   * @param message - Stable explanation without archive contents.
   */
  constructor(message: string) {
    super(message);
    this.name = "OrganizationArchiveError";
  }
}

export type OrganizationArchive = z.infer<typeof organizationArchiveSchema>;

export function parseOrganizationArchive(raw: unknown): OrganizationArchive {
  const parsed = organizationArchiveSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OrganizationArchiveError("Archive does not match version 1");
  }
  assertArchiveReferences(parsed.data);
  return parsed.data;
}
```

Use independent `Map<string, row>` indexes for each source-id collection. Validate parent existence and same-project constraints for edges and note/task links. Sum the lengths of all fourteen row arrays and reject totals over `MAX_ORGANIZATION_ARCHIVE_ROWS`.

`decodeOrganizationArchive` must use a fatal UTF-8 decoder, `JSON.parse`, and `parseOrganizationArchive`. `serializeOrganizationArchive` must stringify once, measure with `TextEncoder`, and reject output over `MAX_ORGANIZATION_ARCHIVE_BYTES`. `organizationArchiveFilename` must return `piyaz-${slug}-workspace.json` after replacing characters outside `[a-z0-9-]` with `-`.

- [ ] **Step 4: Run the parser tests and verify GREEN**

Run: `bun test tests/organization-portability/archive.test.ts`

Expected: PASS with all malformed contracts rejected for the intended reason.

- [ ] **Step 5: Run focused static checks**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the contract**

```bash
git add lib/organization-portability/archive.ts tests/organization-portability/archive.test.ts
git commit -S -m "feat: define organization archive contract"
```

### Task 2: Owner-scoped workspace export

**Files:**
- Create: `lib/data/organization-portability.ts`
- Create: `tests/data/organization-portability.test.ts`

**Interfaces:**
- Consumes: `OrganizationArchive` from Task 1 and all workspace table definitions from `lib/db/schema.ts`.
- Produces: `OrganizationExportForbiddenError` and `exportOrganizationWorkspace(userId: string, organizationId: string): Promise<OrganizationArchive>`.

- [ ] **Step 1: Write failing export integration tests**

Seed one organization containing every supported table. Use fixed timestamps and literal content. Add the owner, a second member, an owner-private note, a second-member private note, a team note, revisions on each visible note, note activity before and after sharing, owner and second-member task assignments, user-attributed links, task activity, note links, feed links, folders, criteria, decisions, and edges.

Assert the exact exported arrays and these privacy properties:

```ts
test("exports every visible workspace row and complete history", async () => {
  const fixture = await seedPortableWorkspace("export-complete");

  const archive = await exportOrganizationWorkspace(
    fixture.ownerUserId,
    fixture.organizationId,
  );

  expect(archive.activityEvents.map((event) => event.summary)).toEqual([
    "created the project",
    "changed status to active",
    "updated migration note",
  ]);
  expect(archive.noteRevisions.map((revision) => revision.version)).toEqual([
    1, 2,
  ]);
  expect(archive.taskAssignments).toEqual([
    { taskSourceId: fixture.taskId, createdAt: fixture.assignmentCreatedAt },
  ]);
});

test("does not export another member's private content or identity", async () => {
  const fixture = await seedPortableWorkspace("export-private");

  const archive = await exportOrganizationWorkspace(
    fixture.ownerUserId,
    fixture.organizationId,
  );
  const serialized = JSON.stringify(archive);

  expect(serialized).not.toContain(fixture.otherUserId);
  expect(serialized).not.toContain(fixture.otherEmail);
  expect(serialized).not.toContain("other member private body");
  expect(archive.taskAssignments).toHaveLength(1);
});
```

Also assert `OrganizationExportForbiddenError` for an admin, member, non-member, malformed organization id, and missing organization. The malformed id must fail before a `::uuid` cast reaches PostgreSQL.

- [ ] **Step 2: Run export tests and verify RED**

Run: `bun test tests/data/organization-portability.test.ts -t export`

Expected: FAIL because the export function is missing.

- [ ] **Step 3: Implement one-snapshot RLS export**

Use `withUserContextRead(userId, read => [...])` with explicit projections for organization membership and every included table. Each query must outer-scope through `projects.organizationId = organizationId`; do not select generated `notes.searchTsv`.

The organization membership query must read `current_user_orgs()` and require `parseMemberRoles(member_role).includes("owner")` after the batch resolves. All other result sets remain inaccessible outside the caller's RLS scope even though they are fetched in the same static read batch.

Normalize fields as follows:

```ts
function attribution(sourceUserId: string | null, exporterId: string) {
  return sourceUserId === exporterId ? ("exporter" as const) : null;
}
```

- Include task assignments only where `task_assignees.user_id = userId`.
- Set activity `actor` with `attribution`, set `actorClientId` nowhere in the archive, and null `targetRef` for assignee events.
- Retain task ids in edge-event targets, criteria ids in criterion-event targets, and decision ids in decision-event targets so import can remap them.
- Map note/link/revision attribution with `attribution`.
- Sort every array deterministically by `createdAt`, then `sourceId`; sort assignments by task source id.
- Set `format`, `version`, and `exportedAt` only after the read succeeds.

- [ ] **Step 4: Run export tests and verify GREEN**

Run: `bun test tests/data/organization-portability.test.ts -t export`

Expected: PASS.

- [ ] **Step 5: Run existing privacy and RLS regressions**

Run: `bun test tests/data/note-activity-rls.test.ts tests/data/account.test.ts tests/db/rls-coverage.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit export data support**

```bash
git add lib/data/organization-portability.ts tests/data/organization-portability.test.ts
git commit -S -m "feat: export owner workspace data"
```

### Task 3: Transactional workspace restore

**Files:**
- Modify: `lib/data/organization-portability.ts`
- Modify: `tests/data/organization-portability.test.ts`

**Interfaces:**
- Consumes: validated `OrganizationArchive` and a destination organization already owned by the importing user.
- Produces: `OrganizationImportSummary` and `importOrganizationWorkspace(userId: string, organizationId: string, archive: OrganizationArchive): Promise<OrganizationImportSummary>`.

- [ ] **Step 1: Write failing round-trip and rollback tests**

Export the rich source fixture from Task 2, create an empty destination organization owned by a different user, import, and query destination rows as superuser for an exact field comparison. Exclude primary ids, organization id, generated search data, organization creation time, and intentionally normalized user fields from equality.

```ts
test("round trips workspace content with fresh ids and preserved history", async () => {
  const source = await seedPortableWorkspace("roundtrip-source");
  const archive = await exportOrganizationWorkspace(
    source.ownerUserId,
    source.organizationId,
  );
  const destination = await seedEmptyOwnedOrganization("roundtrip-destination");

  const summary = await importOrganizationWorkspace(
    destination.userId,
    destination.organizationId,
    archive,
  );

  expect(summary).toEqual({
    projectCount: archive.projects.length,
    taskCount: archive.tasks.length,
    noteCount: archive.notes.length,
    activityEventCount: archive.activityEvents.length,
  });
  const restored = await readPortableWorkspace(destination.organizationId);
  expect(restored.activityEvents).toEqual(expectedImportedEvents(archive));
  expect(restored.noteRevisions).toEqual(expectedImportedRevisions(archive));
  expect(restored.sourceIds).not.toContain(source.projectId);
});
```

Add tests for importing the same archive twice into different organizations, mapping owner assignments and attribution to the importer, nulling other attribution, remapping event targets, restoring soft-deleted notes, and rolling back every inserted row when a valid archive triggers a database constraint failure inside the transaction.

- [ ] **Step 2: Run import tests and verify RED**

Run: `bun test tests/data/organization-portability.test.ts -t "round trips|rolls back|imports the same"`

Expected: FAIL because the import function is missing.

- [ ] **Step 3: Implement fresh-id maps and batched insertion**

Create one `Map<string, string>` per source-id collection using `crypto.randomUUID()`. Use a documented private `insertBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>): Promise<void>` helper with batches of 500 rows to stay below PostgreSQL bind-parameter limits.

Run the complete restore inside one `withUserContext(userId, async tx => {})`. Insert in this dependency order:

1. projects
2. tasks
3. task edges, exporter assignments, criteria, decisions, and task links
4. notes and folders
5. note/task, note/feed, note/note links, and note revisions
6. activity events

Map activity targets by event kind:

```ts
function remapActivityTarget(
  event: OrganizationArchive["activityEvents"][number],
  maps: ArchiveIdMaps,
): string | null {
  if (event.targetRef === null) return null;
  if (event.type.startsWith("criterion_")) {
    return maps.criteria.get(event.targetRef) ?? null;
  }
  if (event.type.startsWith("decision_")) {
    return maps.decisions.get(event.targetRef) ?? null;
  }
  if (event.type.startsWith("edge_")) {
    return maps.tasks.get(event.targetRef) ?? null;
  }
  if (event.type.startsWith("assignee_")) return null;
  return event.targetRef;
}
```

Set every imported note and folder `createdBy` to `userId` to satisfy RLS attribution floors. Map exporter attribution on revisions, links, note updates/share requests, and activity actors to `userId`; otherwise insert null. Preserve note visibility and visible history exactly as exported.

After child inserts and trigger-driven clock propagation finish, restore stored clocks from leaf to root: edges, criteria/decisions, notes, tasks, then projects. This final ordering prevents a later trigger from advancing a parent past its archived timestamp. Return only the four summary counts shown in the test.

- [ ] **Step 4: Run import tests and verify GREEN**

Run: `bun test tests/data/organization-portability.test.ts`

Expected: PASS.

- [ ] **Step 5: Run mutation and trigger regressions**

Run: `bun test tests/data/task.test.ts tests/data/note.test.ts tests/data/activity-list.test.ts tests/data/note-revision-restore.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit restore support**

```bash
git add lib/data/organization-portability.ts tests/data/organization-portability.test.ts
git commit -S -m "feat: restore organization workspace archives"
```

### Task 4: Export and import Route Handlers

**Files:**
- Create: `lib/organization-portability/organization-lifecycle.ts`
- Create: `app/api/organization/[organizationId]/export/route.ts`
- Create: `app/api/organization/import/route.ts`
- Create: `tests/api/organization-portability.test.ts`

**Interfaces:**
- Consumes: archive and data interfaces from Tasks 1 through 3, `auth.api.createOrganization`, `auth.api.deleteOrganization`, `getAuthContext`, `consentGateResponse`, `readBodyBounded`, rate-limit helpers, slug rules, and Better Auth error mapping.
- Produces: GET file download and POST `{ organizationId }` JSON response.

- [ ] **Step 1: Write failing route tests**

Test GET responses for unauthenticated 401, owner 200 with attachment headers, admin/member/non-member 403, malformed id 400, rate limit 429, and oversized serialized export 413.

Test POST responses for unauthenticated 401, stale legal consent 403, wrong media type 415, false/missing DPA header 400, declared and chunked bodies over 100 MiB returning 413, malformed JSON 400, unsupported version 400, organization-limit and slug-exhaustion failures, successful 201, and workspace failure followed by compensating organization deletion.

```ts
test("GET returns a downloadable owner archive", async () => {
  const fixture = await seedPortableWorkspace("route-export");
  setSession({ user: { id: fixture.ownerUserId } });

  const response = await exportGET(
    new Request("http://test/api/organization/id/export"),
    { params: Promise.resolve({ organizationId: fixture.organizationId }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe(
    ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  );
  expect(response.headers.get("Content-Disposition")).toContain(
    "piyaz-team-route-export-workspace.json",
  );
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `bun test tests/api/organization-portability.test.ts`

Expected: FAIL because both routes are missing.

- [ ] **Step 3: Implement organization lifecycle orchestration**

`organization-lifecycle.ts` exports:

```ts
export type ImportedOrganization = { id: string; name: string; slug: string };

export async function createImportedOrganization(input: {
  name: string;
  slug: string;
  dpaAccepted: true;
  headers: Headers;
}): Promise<ImportedOrganization>;

export async function deleteImportedOrganization(input: {
  organizationId: string;
  headers: Headers;
}): Promise<void>;
```

The create helper derives a valid base slug, attempts it once, then attempts four candidates suffixed with the first eight hexadecimal characters of `crypto.randomUUID()`. Retry only when `mapBetterAuthError` returns `slug_taken`; propagate every other typed lifecycle error. The delete helper calls Better Auth's organization delete API with the explicit destination id.

- [ ] **Step 4: Implement the export route**

Authenticate with `getAuthContext`, apply a 5-per-user and 10-per-address per-minute `organization.export` limit, validate the UUID, call `exportOrganizationWorkspace`, serialize once, and return a `Response` with `Content-Type`, `Content-Disposition: attachment`, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`.

Map errors without exposing organization existence: all ownership failures return `{ code: "forbidden", error: "You don't have permission to export this workspace." }` with 403.

- [ ] **Step 5: Implement the import route**

Authenticate and enforce current consent before body work. Apply the same 5/10 per-minute bound under `organization.import`. Require the exact media type and `X-Piyaz-DPA-Accepted: true`, reject `Content-Length` over the byte limit, call `readBodyBounded`, and decode/validate before organization creation.

Create the organization, call `importOrganizationWorkspace`, and return 201. If restore throws, call `deleteImportedOrganization` before returning an internal error. If cleanup also throws, log only destination ids and error objects; never log archive fields.

- [ ] **Step 6: Run route tests and verify GREEN**

Run: `bun test tests/api/organization-portability.test.ts`

Expected: PASS.

- [ ] **Step 7: Run request-boundary regressions**

Run: `bun test tests/api tests/security/workers-request-shim.test.ts tests/db/request-scope.workers.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the HTTP surface**

```bash
git add lib/organization-portability/organization-lifecycle.ts app/api/organization tests/api/organization-portability.test.ts
git commit -S -m "feat: add workspace archive routes"
```

### Task 5: Teams settings export and import controls

**Files:**
- Create: `app/settings/_components/team-manage/WorkspaceExportSection.tsx`
- Create: `app/settings/_components/ImportWorkspacePanel.tsx`
- Modify: `app/settings/_components/TeamManageModal.tsx`
- Modify: `app/settings/_components/TeamsTab.tsx`
- Create: `tests/ui/organization-portability.test.ts`

**Interfaces:**
- Consumes: route contracts from Task 4, `DpaConsentCheckbox`, `Button`, `TeamView`, and the existing `TeamsTab.handleAdded` refresh callback.
- Produces: `WorkspaceExportSection`, `ImportWorkspacePanel`, `readPortabilityError(response: Response): Promise<string>`, and an `onImported(organizationId: string)` callback.

- [ ] **Step 1: Read the frontend-design skill and current design source**

Read `/home/frkn/.codex/plugins/cache/claude-plugins-official/frontend-design/local/skills/frontend-design/SKILL.md` completely and read `DESIGN.md` if it exists. Keep the approved layout: export inside owner management and import beside Create/Join.

- [ ] **Step 2: Write failing pure UI behavior tests**

Test `organizationArchiveFilename` with unsafe slugs and `readPortabilityError` with the route's coded JSON response, plain error response, and malformed response. Test the pure `canImportWorkspace(file, dpaAccepted, pending)` predicate used by the panel.

```ts
test("requires a selected file and DPA acceptance", () => {
  const file = new File(["{}"], "workspace.json", {
    type: ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  });

  expect(canImportWorkspace(null, true, false)).toBe(false);
  expect(canImportWorkspace(file, false, false)).toBe(false);
  expect(canImportWorkspace(file, true, true)).toBe(false);
  expect(canImportWorkspace(file, true, false)).toBe(true);
});
```

- [ ] **Step 3: Run UI behavior tests and verify RED**

Run: `bun test tests/ui/organization-portability.test.ts`

Expected: FAIL because the UI helpers and components are missing.

- [ ] **Step 4: Implement the owner export section**

`WorkspaceExportSection` accepts `teamId`, `teamSlug`, and `onError`. On click, fetch the export route, parse a failure through `readPortabilityError`, and on success save `await response.blob()` through a temporary object URL using `organizationArchiveFilename(teamSlug)`. Revoke the object URL after the click. Disable duplicate clicks with a synchronous ref plus transition pending state, following existing AccountTab patterns.

Render it only inside `ModalBody`'s existing `isOwner` branch, immediately before `DangerZone`. Admins and members therefore receive no UI affordance while the route remains the authoritative gate.

- [ ] **Step 5: Implement the import panel**

Add **Import workspace** beside Create and Join in `TeamsTab`. Keep create, join, and import panels mutually exclusive. `ImportWorkspacePanel` accepts one `.json` file up to 100 MiB, displays filename and formatted size, requires `DpaConsentCheckbox`, and POSTs the raw `File` with the exact archive media type and DPA header.

On a 201 response, parse `{ organizationId }` and call the existing `handleAdded`, which refreshes, highlights the new team, and refreshes the router. Keep the panel open with its inline error when import or refresh fails.

- [ ] **Step 6: Run UI behavior tests and verify GREEN**

Run: `bun test tests/ui/organization-portability.test.ts`

Expected: PASS.

- [ ] **Step 7: Run browser verification through the repository verify skill**

Verify at desktop and narrow viewport widths:

- Owner management shows Export workspace and downloads a valid file.
- Admin and member management omit the export section.
- Import panel is mutually exclusive with Create and Join.
- Import stays disabled until file and DPA consent are present.
- Invalid archives show inline errors without closing the panel.
- A successful import closes the panel and highlights the new team.
- Focus, keyboard operation, loading labels, and error announcements remain usable.

- [ ] **Step 8: Commit the settings UI**

```bash
git add app/settings/_components/TeamManageModal.tsx app/settings/_components/TeamsTab.tsx app/settings/_components/ImportWorkspacePanel.tsx app/settings/_components/team-manage/WorkspaceExportSection.tsx tests/ui/organization-portability.test.ts
git commit -S -m "feat: add workspace transfer controls"
```

### Task 6: Full verification and compliance review

**Files:**
- Modify only files required by failures directly caused by Tasks 1 through 5.

**Interfaces:**
- Consumes: all implemented archive, data, route, and UI surfaces.
- Produces: a clean CI-equivalent verification result without unrelated edits.

- [ ] **Step 1: Format the changed files**

Run:

```bash
bun x biome format --write \
  lib/organization-portability/archive.ts \
  lib/organization-portability/organization-lifecycle.ts \
  lib/data/organization-portability.ts \
  app/api/organization/[organizationId]/export/route.ts \
  app/api/organization/import/route.ts \
  app/settings/_components/TeamManageModal.tsx \
  app/settings/_components/TeamsTab.tsx \
  app/settings/_components/ImportWorkspacePanel.tsx \
  app/settings/_components/team-manage/WorkspaceExportSection.tsx \
  tests/organization-portability/archive.test.ts \
  tests/data/organization-portability.test.ts \
  tests/api/organization-portability.test.ts \
  tests/ui/organization-portability.test.ts
```

Expected: formatter exits 0 and touches only the listed feature files.

- [ ] **Step 2: Run format check, lint, and typecheck**

Run: `bun run format:check && bun run lint && bun run typecheck`

Expected: all commands exit 0.

- [ ] **Step 3: Verify generated schema remains unchanged**

Run: `bun run db:generate && git status --short drizzle lib/db/schema.ts`

Expected: no migration or schema diff.

- [ ] **Step 4: Run focused portability tests**

Run: `bun test tests/organization-portability/archive.test.ts tests/data/organization-portability.test.ts tests/api/organization-portability.test.ts tests/ui/organization-portability.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Run the complete test suite**

Run: `bun run test`

Expected: PASS with zero failures.

- [ ] **Step 6: Run plugin consistency**

Run: `bun run check:plugins`

Expected: PASS.

- [ ] **Step 7: Build and smoke the Cloudflare target**

Run: `bun run build:cf && bun run smoke:cf`

Expected: both commands exit 0 and the local Worker smoke reports no runtime error.

- [ ] **Step 8: Audit the final diff against the specification**

Confirm each included table has an export projection, validator, id map, insert path, and round-trip assertion. Confirm excluded member/auth/legal fields never enter the archive. Confirm routes log no archive content. Confirm no unrelated tracked or untracked files changed.
