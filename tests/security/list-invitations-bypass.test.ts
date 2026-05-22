import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { auth } from "@/lib/auth";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { listPendingInvitationsAction } from "@/lib/actions/team-invitations";
import type { BetterAuthInvitationRow } from "@/lib/actions/team-invitations-map";

/**
 * AC #4 (MYMR-155): pin the two halves of the list-invitations security
 * contract.
 *
 * (a) A non-admin org member hitting
 *     `GET /api/auth/organization/list-invitations` directly through the
 *     BA HTTP dispatcher receives a `404 "Not Found"` with no invitation
 *     rows in the body — `disabledPaths` short-circuits the route at
 *     `node_modules/better-auth/dist/api/index.mjs:163-165` BEFORE any
 *     plugin handler runs. This closes the bypass: BA's `listInvitations`
 *     route (`crud-invites.mjs:471-488`) only checks team membership,
 *     so without the disable any non-admin member could harvest invitee
 *     emails.
 *
 * (b) An admin call to `listPendingInvitationsAction` still returns the
 *     seeded invitation — the action uses the internal
 *     `auth.api.listInvitations()` callsite (`lib/actions/team-invitations.ts:84`)
 *     which bypasses the HTTP layer entirely. The admin gate at
 *     `lib/actions/team-invitations.ts:70-80` keeps non-admins out of
 *     this path; the action becomes the only supported way to list
 *     invitee emails.
 *
 * `next/headers` is mocked at file-top so the action's internal
 * `headers()` call resolves under the test runtime (matches
 * `tests/auth/org-permissions.test.ts:37-39`). `auth.api.hasPermission`
 * is spied via `spyOn` in `beforeAll` and restored in `afterAll` —
 * `mock.module("@/lib/auth", ...)` is unrestoreable per Bun docs and
 * would block any test that needs the real BA handler (e.g.
 * `tests/auth/cookie-attributes.test.ts`) in the same `bun test` run.
 *
 * Loopback IPs `127.0.0.155` / `127.0.0.156` are unique within the
 * `127.0.0.x` range owned by `tests/auth/cookie-attributes.test.ts`,
 * so BA's in-memory `/sign-in/email` rate-limiter cannot
 * cross-contaminate with that file or with `tests/auth/rate-limit.test.ts`
 * (which owns `127.0.1.x`).
 */

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

type HasPermissionImpl = () => Promise<{ success: boolean }>;
type ListInvitationsImpl = () => Promise<BetterAuthInvitationRow[]>;

let nextHasPermission: HasPermissionImpl = async () => ({ success: false });
let nextListInvitations: ListInvitationsImpl = async () => [];
let hasPermissionSpy: ReturnType<typeof spyOn>;
let listInvitationsSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  hasPermissionSpy = spyOn(
    auth.api as unknown as { hasPermission: HasPermissionImpl },
    "hasPermission",
  ).mockImplementation(() => nextHasPermission());
  // Spy on the internal `auth.api.listInvitations` callsite too. The
  // action calls it with `headers: await headers()`; under the test
  // runtime the `next/headers` mock returns an empty Headers object, so
  // BA's session lookup inside listInvitations throws UNAUTHORIZED before
  // the spied `hasPermission` is ever consulted. The action's admin gate
  // is already exercised via the `hasPermission` spy; pinning the BA
  // listInvitations return value here lets the test focus on what the
  // action does with the rows (filter + project + sort) rather than on
  // BA's session machinery. spyOn is restoreable so other test files in
  // the same run still get the real handler.
  listInvitationsSpy = spyOn(
    auth.api as unknown as { listInvitations: ListInvitationsImpl },
    "listInvitations",
  ).mockImplementation(() => nextListInvitations());
});

afterAll(() => {
  hasPermissionSpy.mockRestore();
  listInvitationsSpy.mockRestore();
});

afterEach(async () => {
  nextHasPermission = async () => ({ success: false });
  nextListInvitations = async () => [];
  setSession(null);
  await truncateAll();
});

/**
 * Seed a pending invitation row via the superuser pool (matches the
 * team_invite_code pattern at `tests/actions/team-invite-code-action.test.ts:74-86`).
 * Sets `status` explicitly even though the column defaults to "pending"
 * so the AC#4(b) filter at `lib/actions/team-invitations.ts:98-103`
 * (`row.status === "pending" && expiresAt > now`) is trivially satisfied.
 * `expiresAt` is +24h from now, well outside any plausible test runtime.
 *
 * @param orgId - Organization that owns the invitation.
 * @param inviterId - User who issued the invitation (FK into `neon_auth.user`).
 * @param email - Invitee email.
 * @returns The inserted row id.
 */
async function seedInvitation(
  orgId: string,
  inviterId: string,
  email: string,
): Promise<{ id: string }> {
  const su = superuserPool();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  const [row] = await su<{ id: string }[]>`
    INSERT INTO neon_auth."invitation"
      ("organizationId", "email", "role", "status", "expiresAt", "inviterId")
    VALUES
      (${orgId}, ${email}, 'member', 'pending', ${expiresAt}, ${inviterId})
    RETURNING id
  `;
  return row;
}

describe("list-invitations HTTP bypass (MYMR-155)", () => {
  test("AC#4(a): non-admin member hitting GET /api/auth/organization/list-invitations directly receives 404", async () => {
    const owner = await seedUserOrgProject("mymr155-owner");
    await seedInvitation(
      owner.organizationId,
      owner.userId,
      "invitee@test.local",
    );

    // Real sign-in pattern (`tests/auth/cookie-attributes.test.ts:90-103`):
    // signUp then sign-in via auth.handler, extract the session_token
    // Set-Cookie. Exercises the full HTTP auth stack — the exact surface
    // the bypass test is meant to pin.
    const memberEmail = "mymr155-member-session@test.local";
    const memberPassword = "test-password-12345";
    await auth.api.signUpEmail({
      body: {
        email: memberEmail,
        name: "MYMR-155 Member",
        password: memberPassword,
      },
    });
    const signInResp = await auth.handler(
      new Request("https://example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "127.0.0.155",
        },
        body: JSON.stringify({
          email: memberEmail,
          password: memberPassword,
        }),
      }),
    );
    expect(signInResp.status).toBe(200);
    const sessionCookie = signInResp.headers
      .getSetCookie()
      .find((c) => c.toLowerCase().includes("session_token"));
    expect(sessionCookie).toBeDefined();

    // Direct hit on the BA endpoint. The catch-all route forwards
    // `/api/auth/organization/list-invitations` to `auth.handler`
    // verbatim; BA's `normalizePathname` strips the `/api/auth` basePath
    // before the `disabledPaths.includes()` check at
    // `node_modules/better-auth/dist/api/index.mjs:163-165`.
    const resp = await auth.handler(
      new Request(
        `https://example.test/api/auth/organization/list-invitations?organizationId=${owner.organizationId}`,
        {
          method: "GET",
          headers: {
            Cookie: sessionCookie!,
            "cf-connecting-ip": "127.0.0.156",
          },
        },
      ),
    );

    // BA returns `new Response("Not Found", { status: 404 })` for
    // disabled paths — plain text body, not JSON. The AC asserts both
    // the status and the absence of invitation rows; reading the body
    // as text and verifying it does not contain the seeded invitee
    // email pins both.
    expect(resp.status).toBe(404);
    const body = await resp.text();
    expect(body).not.toContain("invitee@test.local");
  });

  test("AC#4(b): admin call to listPendingInvitationsAction returns the seeded invitation", async () => {
    const owner = await seedUserOrgProject("mymr155-admin");
    const seeded = await seedInvitation(
      owner.organizationId,
      owner.userId,
      "invitee-admin@test.local",
    );

    // Drive `requireSession()` inside the action. The preload's
    // requireSession mock (`tests/setup/preload.ts:83-91`) closes over
    // the session container; `setSession` swaps it.
    setSession({ user: { id: owner.userId } });
    // Force `isOrgAdmin -> true` via the hasPermission spy armed in
    // beforeAll. Mirrors `tests/auth/org-permissions.test.ts:107-111`.
    nextHasPermission = async () => ({ success: true });
    // Surface the seeded row through the BA listInvitations spy — the
    // real BA call would need a live session cookie at the
    // auth-api boundary, which the in-process test runtime does not
    // supply (the `next/headers` mock returns an empty Headers).
    nextListInvitations = async () => [
      {
        id: seeded.id,
        organizationId: owner.organizationId,
        email: "invitee-admin@test.local",
        role: "member",
        status: "pending",
        inviterId: owner.userId,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
        createdAt: new Date(),
      },
    ];

    const result = await listPendingInvitationsAction({
      organizationId: owner.organizationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable: ok asserted above");
    expect(result.data.length).toBe(1);
    expect(result.data[0].email).toBe("invitee-admin@test.local");
    // Sanity: the row we get back is the one we seeded.
    expect(result.data.map((r) => r.id)).toContain(seeded.id);
  });
});
