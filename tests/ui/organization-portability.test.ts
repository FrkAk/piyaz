/** Pure client behavior coverage for workspace archive controls. */

import { expect, test } from "bun:test";
import {
  canImportWorkspace,
  readPortabilityError,
} from "@/lib/organization-portability/client";
import {
  MAX_ORGANIZATION_ARCHIVE_BYTES,
  ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  organizationArchiveFilename,
} from "@/lib/organization-portability/archive";

test("requires a selected JSON file, DPA acceptance, and idle state", () => {
  const file = new File(["{}"], "workspace.json", {
    type: ORGANIZATION_ARCHIVE_MEDIA_TYPE,
  });
  const wrongExtension = new File(["{}"], "workspace.txt");
  const oversized = {
    name: "workspace.json",
    size: MAX_ORGANIZATION_ARCHIVE_BYTES + 1,
  };

  expect(canImportWorkspace(null, true, false)).toBe(false);
  expect(canImportWorkspace(file, false, false)).toBe(false);
  expect(canImportWorkspace(file, true, true)).toBe(false);
  expect(canImportWorkspace(wrongExtension, true, false)).toBe(false);
  expect(canImportWorkspace(oversized, true, false)).toBe(false);
  expect(canImportWorkspace(file, true, false)).toBe(true);
});

test("reads coded JSON route errors without exposing other response bodies", async () => {
  const coded = Response.json(
    { code: "invalid_archive", error: "Invalid workspace archive." },
    { status: 400 },
  );
  const plain = new Response("Storage is temporarily unavailable.", {
    status: 503,
    headers: { "content-type": "text/plain" },
  });

  expect(await readPortabilityError(coded)).toBe("Invalid workspace archive.");
  expect(await readPortabilityError(plain)).toBe(
    "Workspace transfer failed. Try again.",
  );
});

test("uses a stable fallback for malformed or empty responses", async () => {
  const malformed = new Response("{", {
    status: 500,
    headers: { "content-type": "application/json" },
  });
  const empty = new Response(null, { status: 500 });

  expect(await readPortabilityError(malformed)).toBe(
    "Workspace transfer failed. Try again.",
  );
  expect(await readPortabilityError(empty)).toBe(
    "Workspace transfer failed. Try again.",
  );
});

test("builds a safe workspace download filename", () => {
  expect(organizationArchiveFilename("My Team/../prod")).toBe(
    "piyaz-my-team-prod-workspace.json",
  );
});
