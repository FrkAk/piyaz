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
 * MYMR-155 security contract — two halves:
 *
 * (a) Non-admin HTTP harvest is closed. The catch-all allowlist at
 *     `app/api/auth/[...all]/route.ts` 404s every `/organization/*`
 *     path (and every other non-allowlisted BA path) before
 *     `auth.handler` is invoked, so neither `list-invitations` nor the
 *     sibling `get-full-organization` leak is reachable. Regressions
 *     live in the first describe block below.
 *
 * (b) Admin reads still work via `listPendingInvitationsAction`, which
 *     uses the internal `auth.api.listInvitations()` callsite
 *     (`lib/actions/team-invitations.ts:84`) — that path bypasses HTTP
 *     entirely. The admin gate at `lib/actions/team-invitations.ts:70-80`
 *     keeps non-admins out, making the action the only supported way
 *     to list invitee emails. Pinned by the second describe block.
 *
 * `next/headers` is mocked at file-top so the action's internal
 * `headers()` call resolves under the test runtime (matches
 * `tests/auth/org-permissions.test.ts:37-39`). `auth.api.hasPermission`
 * and `auth.api.listInvitations` are spied via `spyOn` in `beforeAll`
 * and restored in `afterAll` — `mock.module("@/lib/auth", ...)` is
 * unrestoreable per Bun docs and would block any test that needs the
 * real BA handler (e.g. `tests/auth/cookie-attributes.test.ts`) in the
 * same `bun test` run.
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

describe("catch-all HTTP allowlist (MYMR-155)", () => {
  // The route at `app/api/auth/[...all]/route.ts` is the primary gate:
  // anything not on the explicit allowlist returns 404 "Not Found"
  // BEFORE `auth.handler` is invoked, so the whole `/organization/*`
  // family is unreachable from the network — closing the sibling
  // `get-full-organization` leak that was equivalent in impact to the
  // `list-invitations` bypass MYMR-155 originally targeted.
  test("GET /organization/get-full-organization is 404'd by the gate (sibling bypass closed)", async () => {
    const { GET } = await import("@/app/api/auth/[...all]/route");
    const resp = await GET(
      new Request(
        "https://example.test/api/auth/organization/get-full-organization?organizationId=anything",
        { method: "GET" },
      ),
    );
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Not Found");
  });

  test("GET /organization/list-invitations is 404'd by the gate (defense-in-depth above BA disabledPaths)", async () => {
    const { GET } = await import("@/app/api/auth/[...all]/route");
    const resp = await GET(
      new Request(
        "https://example.test/api/auth/organization/list-invitations",
        { method: "GET" },
      ),
    );
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Not Found");
  });

  test("trailing-slash variant of a blocked path stays blocked (mirrors BA's normalizePathname)", async () => {
    const { GET } = await import("@/app/api/auth/[...all]/route");
    const resp = await GET(
      new Request(
        "https://example.test/api/auth/organization/get-full-organization/",
        { method: "GET" },
      ),
    );
    expect(resp.status).toBe(404);
  });

  test("allowlisted path (`/get-session`) is forwarded to auth.handler, not 404'd by the gate", async () => {
    const { GET } = await import("@/app/api/auth/[...all]/route");
    const resp = await GET(
      new Request("https://example.test/api/auth/get-session", {
        method: "GET",
      }),
    );
    // Gate over-block would return body "Not Found"; BA returns its
    // own response for an unauthenticated get-session call.
    expect(await resp.text()).not.toBe("Not Found");
  });

  test("non-admin member of the target org gets 404 from the gate on both list-invitations and get-full-organization", async () => {
    // The exact role MYMR-155 closed: a non-admin org member trying to
    // harvest their own org's invitee emails. Without the gate, BA's
    // membership check would PASS for this caller (they ARE a member),
    // and both routes would return invitation rows — that is the
    // bypass. The gate short-circuits to 404 before BA's
    // session/membership middleware runs.
    //
    // Loopback IPs `127.0.0.155` / `127.0.0.156` are unique within the
    // `127.0.0.x` range owned by `tests/auth/cookie-attributes.test.ts`,
    // so BA's in-memory `/sign-in/email` rate-limiter cannot
    // cross-contaminate with that file or with
    // `tests/auth/rate-limit.test.ts` (which owns `127.0.1.x`).
    const targetOrg = await seedUserOrgProject("mymr155-target");
    await seedInvitation(
      targetOrg.organizationId,
      targetOrg.userId,
      "victim-invitee@test.local",
    );

    const attackerEmail = "mymr155-nonadmin-member@test.local";
    const attackerPassword = "test-password-12345";
    await auth.api.signUpEmail({
      body: {
        email: attackerEmail,
        name: "MYMR-155 Non-admin Member",
        password: attackerPassword,
      },
    });
    const su = superuserPool();
    const [attacker] = await su<{ id: string }[]>`
      SELECT id FROM neon_auth."user" WHERE email = ${attackerEmail}
    `;
    await su`
      INSERT INTO neon_auth."member"
        ("organizationId", "userId", "role", "createdAt")
      VALUES
        (${targetOrg.organizationId}, ${attacker.id}, 'member', now())
    `;

    const signInResp = await auth.handler(
      new Request("https://example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "127.0.0.155",
        },
        body: JSON.stringify({
          email: attackerEmail,
          password: attackerPassword,
        }),
      }),
    );
    expect(signInResp.status).toBe(200);
    const sessionCookie = signInResp.headers
      .getSetCookie()
      .find((c) => c.toLowerCase().includes("session_token"));
    expect(sessionCookie).toBeDefined();

    const { GET } = await import("@/app/api/auth/[...all]/route");

    for (const path of [
      `/api/auth/organization/list-invitations?organizationId=${targetOrg.organizationId}`,
      `/api/auth/organization/get-full-organization?organizationId=${targetOrg.organizationId}`,
    ]) {
      const resp = await GET(
        new Request(`https://example.test${path}`, {
          method: "GET",
          headers: {
            Cookie: sessionCookie!,
            "cf-connecting-ip": "127.0.0.156",
          },
        }),
      );
      expect(resp.status).toBe(404);
      const body = await resp.text();
      expect(body).toBe("Not Found");
      // Belt-and-braces: invitee email must never appear in any
      // response returned to a non-admin member, regardless of body
      // format.
      expect(body).not.toContain("victim-invitee@test.local");
    }
  });
});

describe("listPendingInvitationsAction (MYMR-155)", () => {
  test("non-admin member of the target org gets forbidden", async () => {
    // Same role as the gate test above, but via the server-action
    // path. The action's gate is `requireSession() + isOrgAdmin()`;
    // `isOrgAdmin()` resolves through `auth.api.hasPermission`, which
    // is spied to return `{ success: false }` — matching what the real
    // call would return for a non-admin member.
    const targetOrg = await seedUserOrgProject("mymr155-target-action");
    const su = superuserPool();
    const [member] = await su<{ id: string }[]>`
      INSERT INTO neon_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES (
        'MYMR-155 Non-admin Member',
        'mymr155-nonadmin-member-action@test.local',
        true,
        now()
      )
      RETURNING id
    `;
    await su`
      INSERT INTO neon_auth."member"
        ("organizationId", "userId", "role", "createdAt")
      VALUES
        (${targetOrg.organizationId}, ${member.id}, 'member', now())
    `;
    setSession({ user: { id: member.id } });

    const result = await listPendingInvitationsAction({
      organizationId: targetOrg.organizationId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable: ok asserted above");
    expect(result.code).toBe("forbidden");
  });

  test("admin call returns the seeded invitation", async () => {
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
