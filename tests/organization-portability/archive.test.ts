import { expect, test } from "bun:test";
import {
  MAX_ORGANIZATION_ARCHIVE_ROWS,
  OrganizationArchiveError,
  decodeOrganizationArchive,
  organizationArchiveFilename,
  parseOrganizationArchive,
  serializeOrganizationArchive,
  type OrganizationArchive,
} from "@/lib/organization-portability/archive";

const P1 = "00000000-0000-4000-8000-000000000001";
const T1 = "00000000-0000-4000-8000-000000000002";
const T2 = "00000000-0000-4000-8000-000000000003";
const E1 = "00000000-0000-4000-8000-000000000004";
const C1 = "00000000-0000-4000-8000-000000000005";
const D1 = "00000000-0000-4000-8000-000000000006";
const L1 = "00000000-0000-4000-8000-000000000007";
const A1 = "00000000-0000-4000-8000-000000000008";
const N1 = "00000000-0000-4000-8000-000000000009";
const N2 = "00000000-0000-4000-8000-000000000010";
const F1 = "00000000-0000-4000-8000-000000000011";
const NT1 = "00000000-0000-4000-8000-000000000012";
const NF1 = "00000000-0000-4000-8000-000000000013";
const NL1 = "00000000-0000-4000-8000-000000000014";
const R1 = "00000000-0000-4000-8000-000000000015";
const NOW = "2026-08-24T12:00:00.000Z";

/**
 * Build an independently specified valid version-1 archive fixture.
 *
 * @returns A complete archive with every supported row collection populated.
 */
function validArchive(): OrganizationArchive {
  return {
    format: "piyaz-organization",
    version: 1,
    exportedAt: NOW,
    organization: { name: "Portable Team", slug: "portable-team" },
    projects: [
      {
        sourceId: P1,
        title: "Portable project",
        identifier: "PORT",
        description: "Project description",
        status: "active",
        categories: ["Backend"],
        createdAt: NOW,
        updatedAt: NOW,
        metaUpdatedAt: NOW,
      },
    ],
    tasks: [
      {
        sourceId: T1,
        projectSourceId: P1,
        title: "First task",
        sequenceNumber: 1,
        description: "Task description",
        status: "in_progress",
        order: 0,
        category: "Backend",
        implementationPlan: "Implement it",
        executionRecord: "Implemented",
        tags: ["migration"],
        priority: "core",
        estimate: 3,
        files: ["lib/example.ts"],
        createdAt: NOW,
        updatedAt: NOW,
        metaUpdatedAt: NOW,
      },
      {
        sourceId: T2,
        projectSourceId: P1,
        title: "Second task",
        sequenceNumber: 2,
        description: "",
        status: "draft",
        order: 1,
        category: null,
        implementationPlan: null,
        executionRecord: null,
        tags: [],
        priority: null,
        estimate: null,
        files: [],
        createdAt: NOW,
        updatedAt: NOW,
        metaUpdatedAt: NOW,
      },
    ],
    taskEdges: [
      {
        sourceId: E1,
        sourceTaskSourceId: T1,
        targetTaskSourceId: T2,
        edgeType: "depends_on",
        note: "Blocks delivery",
        createdAt: NOW,
        updatedAt: NOW,
        metaUpdatedAt: NOW,
      },
    ],
    taskAssignments: [{ taskSourceId: T1, createdAt: NOW }],
    taskAcceptanceCriteria: [
      {
        sourceId: C1,
        taskSourceId: T1,
        text: "Archive validates",
        checked: true,
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    taskDecisions: [
      {
        sourceId: D1,
        taskSourceId: T1,
        text: "Use JSON",
        source: "planning",
        decisionDate: "2026-08-24",
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    taskLinks: [
      {
        sourceId: L1,
        taskSourceId: T1,
        kind: "documentation",
        url: "https://example.test/docs",
        label: "Docs",
        createdAt: NOW,
        createdBy: "exporter",
        metadata: { portable: true },
      },
    ],
    activityEvents: [
      {
        sourceId: A1,
        projectSourceId: P1,
        taskSourceId: T1,
        noteSourceId: null,
        type: "criterion_added",
        createdAt: NOW,
        actor: "exporter",
        source: "web",
        summary: "added criterion",
        targetRef: C1,
        metadata: null,
      },
    ],
    notes: [
      {
        sourceId: N1,
        projectSourceId: P1,
        sequenceNumber: 1,
        type: "guidance",
        folder: "Migration",
        title: "Migration guide",
        slug: "migration-guide",
        summary: "Move the workspace",
        body: "Portable note body",
        visibility: "team",
        sharedSince: NOW,
        agentWritable: true,
        locked: false,
        feedMode: "tasks",
        feedCategories: [],
        feedTags: [],
        tags: ["portable"],
        category: "Backend",
        version: 2,
        embeddingStatus: "ready",
        shareRequestedBy: null,
        createdBy: "exporter",
        updatedBy: "exporter",
        createdAt: NOW,
        updatedAt: NOW,
        metaUpdatedAt: NOW,
        deletedAt: null,
      },
      {
        sourceId: N2,
        projectSourceId: P1,
        sequenceNumber: 2,
        type: "reference",
        folder: "",
        title: "Target note",
        slug: "target-note",
        summary: "",
        body: "Target",
        visibility: "private",
        sharedSince: null,
        agentWritable: false,
        locked: false,
        feedMode: "none",
        feedCategories: [],
        feedTags: [],
        tags: [],
        category: null,
        version: 1,
        embeddingStatus: "none",
        shareRequestedBy: null,
        createdBy: "exporter",
        updatedBy: null,
        createdAt: NOW,
        updatedAt: NOW,
        metaUpdatedAt: NOW,
        deletedAt: NOW,
      },
    ],
    noteFolders: [
      {
        sourceId: F1,
        projectSourceId: P1,
        path: "Migration",
        createdAt: NOW,
      },
    ],
    noteTaskLinks: [
      {
        sourceId: NT1,
        noteSourceId: N1,
        taskSourceId: T1,
        kind: "reference",
        createdAt: NOW,
      },
    ],
    noteFeedTasks: [
      {
        sourceId: NF1,
        noteSourceId: N1,
        taskSourceId: T1,
        createdAt: NOW,
      },
    ],
    noteLinks: [
      {
        sourceId: NL1,
        sourceNoteSourceId: N1,
        targetNoteSourceId: N2,
        createdAt: NOW,
      },
    ],
    noteRevisions: [
      {
        sourceId: R1,
        noteSourceId: N1,
        version: 1,
        title: "Migration guide",
        body: "Original body",
        createdBy: "exporter",
        createdAt: NOW,
      },
    ],
  };
}

test("accepts a complete version-1 archive", () => {
  expect(parseOrganizationArchive(validArchive())).toEqual(validArchive());
});

test("rejects unknown top-level fields", () => {
  const archive = { ...validArchive(), members: [] };
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "Archive does not match version 1",
  );
});

test("rejects unsupported archive versions", () => {
  const archive = { ...validArchive(), version: 2 };
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "Archive does not match version 1",
  );
});

test("rejects duplicate ids inside a row collection", () => {
  const archive = validArchive();
  archive.tasks.push({ ...archive.tasks[0] });
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "tasks contains duplicate sourceId",
  );
});

test("rejects dangling task project references", () => {
  const archive = validArchive();
  archive.tasks[0].projectSourceId = "00000000-0000-4000-8000-000000000099";
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "tasks[0].projectSourceId does not reference an exported project",
  );
});

test("rejects cross-project task edges", () => {
  const archive = validArchive();
  const secondProjectId = "00000000-0000-4000-8000-000000000098";
  archive.projects.push({
    ...archive.projects[0],
    sourceId: secondProjectId,
    identifier: "OTHER",
  });
  archive.tasks[1].projectSourceId = secondProjectId;
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "taskEdges[0] crosses project boundaries",
  );
});

test("rejects cross-project note-task links", () => {
  const archive = validArchive();
  const secondProjectId = "00000000-0000-4000-8000-000000000098";
  archive.projects.push({
    ...archive.projects[0],
    sourceId: secondProjectId,
    identifier: "OTHER",
  });
  archive.tasks[0].projectSourceId = secondProjectId;
  archive.taskEdges = [];
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "noteTaskLinks[0] crosses project boundaries",
  );
});

test("rejects invalid timestamps", () => {
  const archive = validArchive();
  archive.projects[0].createdAt = "yesterday";
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "Archive does not match version 1",
  );
});

test("rejects note bodies beyond the database limit", () => {
  const archive = validArchive();
  archive.notes[0].body = "x".repeat(200_001);
  expect(() => parseOrganizationArchive(archive)).toThrow(
    "Archive does not match version 1",
  );
});

test("rejects aggregate row counts above the portable limit", () => {
  const archive = validArchive();
  archive.activityEvents = new Array(MAX_ORGANIZATION_ARCHIVE_ROWS + 1);
  expect(() => parseOrganizationArchive(archive)).toThrow(
    `Archive exceeds ${MAX_ORGANIZATION_ARCHIVE_ROWS} rows`,
  );
});

test("rejects malformed UTF-8 and malformed JSON", () => {
  expect(() => decodeOrganizationArchive(new Uint8Array([0xc3, 0x28]))).toThrow(
    OrganizationArchiveError,
  );
  expect(() =>
    decodeOrganizationArchive(new TextEncoder().encode("{")),
  ).toThrow(OrganizationArchiveError);
});

test("serializes valid archives and rejects oversized output", () => {
  const archive = validArchive();
  expect(JSON.parse(serializeOrganizationArchive(archive))).toEqual(archive);

  archive.notes[0].body = "x".repeat(200_001);
  expect(() => serializeOrganizationArchive(archive)).toThrow(
    OrganizationArchiveError,
  );
});

test("builds a safe deterministic download filename", () => {
  expect(organizationArchiveFilename("My Team/../prod")).toBe(
    "piyaz-my-team-prod-workspace.json",
  );
});
