# Organization Workspace Portability Design

## Purpose

Piyaz will let an organization owner export the workspace content they can
already access and import that archive into another Piyaz deployment. Import
always creates a new organization owned by the importing user. This supports
migration from the hosted service to a self-hosted deployment without exposing
member accounts or changing existing organizations.

The existing personal account export remains unchanged.

## Scope

An organization archive contains:

- Organization name and slug
- Projects
- Tasks
- Task edges
- The exporting owner's task assignments
- Task acceptance criteria
- Task decisions
- Task links
- Activity events
- Notes visible to the exporting owner, including soft-deleted notes
- Note folders
- Note-to-task links
- Note feed task links
- Note-to-note links
- Note revisions visible to the exporting owner

The archive excludes:

- User profiles and member rosters
- Assignments belonging to other members
- Invitations and invite codes
- Sessions, credentials, OAuth grants, and agent credentials
- Personal and organization legal-acceptance records
- Notes and note history hidden from the exporting owner by RLS
- Generated search columns and other database-only derived state

## Authorization and Privacy

Export requires an authenticated session, current legal consent, and an owner
role on the organization named by the request. Admins and members cannot export
an organization archive. The owner check names the target organization and does
not depend on the session's active organization.

All workspace reads run with the exporting user's RLS context. RLS therefore
remains the privacy boundary for private notes, note revisions, and activity
events. Organization ownership is an additional permission gate, not a bypass
of note visibility.

The archive carries no user ids, names, or email addresses. User-backed fields
are normalized as follows:

- An assignment is included only when assigned to the exporting owner.
- User attribution is represented as `"exporter"` when it belongs to the
  exporting owner and `null` otherwise.
- OAuth client ids and member-backed activity targets are omitted.
- References to workspace records are retained as archive-local ids.

On import, `"exporter"` maps to the importing user. Notes imported from another
author map to the importing user because the destination contains no source
member accounts and note insert policies require a valid local author. Other
nullable attribution remains null.

## Archive Contract

The download is one UTF-8 JSON file with the media type
`application/vnd.piyaz.organization+json`. Its top-level shape is:

```json
{
  "format": "piyaz-organization",
  "version": 1,
  "exportedAt": "2026-08-24T12:00:00.000Z",
  "organization": {
    "name": "Example Team",
    "slug": "example-team"
  },
  "projects": [],
  "tasks": [],
  "taskEdges": [],
  "taskAssignments": [],
  "taskAcceptanceCriteria": [],
  "taskDecisions": [],
  "taskLinks": [],
  "activityEvents": [],
  "notes": [],
  "noteFolders": [],
  "noteTaskLinks": [],
  "noteFeedTasks": [],
  "noteLinks": [],
  "noteRevisions": []
}
```

Every exported workspace row has a `sourceId` copied from its source row.
Relationships use those source ids only as archive-local references; import
never reuses them as destination primary keys. The contract includes all
persisted, user-visible fields and timestamps from each scoped table except the
excluded identity and derived fields listed above. Activity events retain their
type, source, summary, metadata, timestamp, and workspace target references.
Member-backed target references are null. Note revisions retain their version,
title, body, and timestamp.

Version 1 is parsed strictly. Unknown top-level or row fields, unsupported
versions, duplicate source ids, dangling references, cross-project note links,
and values outside current schema limits are rejected before any organization
is created.

Exported timestamps are ISO 8601 strings. Import preserves stored workspace-row
creation, update, deletion, activity, and revision timestamps. The destination
organization's creation timestamp records the import time because Better Auth
creates it as a new organization. Generated columns and derived clocks are
allowed to be recalculated only where the database owns their value.

## Export Flow

The owner selects **Export workspace** from the organization management panel.
The client fetches `GET /api/organization/{organizationId}/export` and saves the
successful response as a file. A route handler is used instead of a server
action so the archive does not pass through React Server Component
serialization.

The route performs these steps:

1. Resolve the authenticated user and legal-consent gate.
2. Apply per-user and per-address export rate limits.
3. Validate the organization id.
4. Verify the caller is an organization owner.
5. Read every scoped table under one caller RLS snapshot.
6. Normalize database ids and user references into the archive contract.
7. Return the JSON attachment with a filename derived from the organization
   slug.

The route returns the same non-disclosing forbidden response for a missing
organization, a non-member, an admin, and a plain member.

## Import Flow

The Teams settings tab adds **Import workspace** beside Create and Join. The
panel accepts one JSON archive and the existing DPA consent control. Import
always creates a new organization and never accepts a destination organization
id.

`POST /api/organization/import` reads the raw request through the repository's
bounded-body reader, decodes UTF-8, parses JSON, and validates the complete
archive before creating state. The client sends the archive as the raw request
body with `Content-Type: application/vnd.piyaz.organization+json` and sends DPA
acceptance as `X-Piyaz-DPA-Accepted: true`. Keeping consent outside the archive
makes the downloaded file deployment-independent.

After validation, import performs these steps:

1. Create a new organization through Better Auth using the archived name and a
   collision-safe slug derived from the archived slug.
2. Build fresh UUID maps for every source project, task, edge, note, event, and
   child row.
3. Insert all workspace rows under the importing user's RLS context in one
   transaction, ordered by foreign-key dependencies.
4. Map exporter attribution and assignments to the importing user.
5. Preserve activity and revision rows directly without emitting new activity
   events.
6. Return the new organization id after the transaction commits.

The insertion order is projects, tasks, task-owned child rows, notes, note-owned
child rows, cross-links, then activity events. Links are inserted only after
both remapped endpoints exist.

If the workspace transaction fails, it rolls back every workspace row. The
route then deletes the newly created empty organization through Better Auth. A
cleanup failure is logged with the new organization id and returned as an
internal failure; existing organizations are never modified.

Import uses fresh UUIDs, so the same valid archive can be imported repeatedly.
The organization keeps its archived name. If the archived slug is unavailable,
the importer appends a short random suffix and makes at most five creation
attempts. Other organization-creation failures, including the
owned-organization limit or missing DPA acceptance, use the existing failure
mapping.

## Validation and Resource Bounds

The import route accepts only the organization archive media type and rejects
an empty body. The archive limit is 100 MiB. It applies to both the declared
`Content-Length` and streamed body. The bounded reader cancels the request as
soon as the limit is crossed so a chunked upload cannot grow without bound
before validation.

The schema bounds strings using the existing database and call-surface limits.
It caps the sum of all row arrays at 500,000 so a small but pathological archive
cannot create unbounded validation or insert work. Export applies the same
100 MiB serialized-size and 500,000-row limits and returns a clear failure when
an organization exceeds either portable archive bound.

No new dependency or database schema change is required. Zod validates the
versioned contract, and existing Drizzle schemas provide the insert types.

## UI

Organization management shows **Export workspace** only for owners. The control
downloads immediately and reports authorization, rate-limit, and server errors
inside the existing management modal.

The Teams tab shows **Import workspace** to authenticated users. Its compact
panel contains a file picker, selected filename and size, DPA consent, Import
and Cancel controls, pending state, and an inline error. The server performs all
archive parsing and validation. After success, the team list refreshes,
highlights the new organization, and closes the panel.

Copy and styling reuse the existing Teams tab, CreateTeamPanel, Button, and DPA
consent patterns. Import is not placed in the account danger zone because it
creates a team and does not mutate the personal account export.

## Errors

Expected failures have stable client-safe responses for unauthorized,
forbidden, legal consent required, rate limited, invalid media type, archive too
large, malformed JSON, unsupported version, invalid archive, DPA not accepted,
organization limit reached, and slug creation exhausted. Validation failures do
not echo archive contents or internal database details.

Unexpected failures use the existing internal-error logging pattern. Logs may
include generated organization and record ids needed for cleanup, but never
archive content, note bodies, task descriptions, or activity metadata.

## Testing

Data and route tests cover:

- Owners can export their organization.
- Admins, members, non-members, and malformed organization ids cannot export.
- Export contains every scoped table and preserves activity events and note
  revisions.
- RLS excludes another member's private notes, revisions, and private-note
  activity.
- Exports contain no member identity or credentials.
- Oversized organizations and uploads fail at the documented boundary.
- Malformed JSON, unsupported versions, duplicate ids, dangling references,
  cross-project links, and invalid values fail before organization creation.
- A round trip restores every supported field, timestamp, activity event,
  revision, and relationship under fresh ids.
- Exporter assignments and attribution map to the importing user while other
  attribution stays absent.
- Importing the same archive twice creates independent organizations.
- A failed workspace insert rolls back all rows and removes the new
  organization.
- Import never changes an existing organization.

UI tests cover owner-only export visibility, file selection, DPA gating,
pending/error states, and refreshing the team list after a successful import.

Verification runs formatter, lint, typecheck, focused tests, the full test
suite, Cloudflare build, and Cloudflare smoke because the change adds route
handlers that run on both deployment targets.

## Alternatives Rejected

### SQL dump

A SQL dump preserves storage details but couples archives to internal schemas,
auth tables, RLS implementation, generated columns, and migration state. It
also requires privileged restore access and makes repeated imports unsafe.

### UI-shaped project export

Reusing current list/detail responses would be smaller to implement but omits
activity history, note revisions, soft-deleted notes, and relationship metadata.
It would not satisfy a complete workspace migration.

### Merge into an existing organization

Merge requires conflict policy for slugs, project identifiers, task sequence
numbers, note titles, and history. It also creates overwrite risk. Importing
into a fresh organization gives deterministic, repeatable behavior.
