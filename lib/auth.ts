import { betterAuth } from "better-auth";
import { organization, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as authSchema from "@/lib/db/auth-schema";
import { authDb } from "@/lib/db/connection";
import { clearOrgMembershipArtifacts } from "@/lib/data/account";
import { clearUserOAuthArtifacts } from "@/lib/data/oauth-session";
import { ac, owner, admin, member as memberRole } from "@/lib/auth/permissions";
import { findOrgMemberUserIdsAsAdmin } from "@/lib/data/membership";
import { grantOrgAccess, revokeOrgAccess } from "@/lib/realtime/access";
import { getKvSecondaryStorage } from "@/lib/db/_auth-kv-storage";

const IS_CLOUDFLARE = process.env.DEPLOY_TARGET === "cloudflare";

if (IS_CLOUDFLARE && !process.env.BETTER_AUTH_URL) {
  throw new Error(
    "BETTER_AUTH_URL is required on the Cloudflare deploy target. " +
      "Without it, Better-auth's trustedOrigins falls back to [] and CSRF " +
      "protection accepts any origin. Set it in wrangler.jsonc env.production.vars.",
  );
}

/**
 * Better Auth server instance with email/password auth and
 * organization-based team management. Adapts the `neon_auth` schema via
 * drizzleAdapter.
 */
export const auth = betterAuth({
  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: authSchema,
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  secondaryStorage: getKvSecondaryStorage(),
  // Belt-and-braces against the non-admin `listInvitations` bypass
  // (BA 1.6.11 `crud-invites.mjs:471-488`, membership-only guard). The
  // primary gate is the catch-all allowlist at
  // `app/api/auth/[...all]/route.ts`, which 404s every BA path that is
  // not explicitly allowed — so the whole `organization/*` family is
  // unreachable from the network. This line also rejects the route
  // when callers reach `auth.handler` directly without going through
  // the catch-all (the existing AC#4(a) regression in
  // `tests/security/list-invitations-bypass.test.ts` exercises that
  // path). Internal `auth.api.listInvitations()` calls (e.g.
  // `lib/actions/team-invitations.ts:84`) bypass the HTTP layer and
  // remain unaffected. Path is the post-basePath normalized form;
  // `normalizePathname` (`@better-auth/core/dist/utils/url.mjs:18-29`)
  // strips `/api/auth` before the includes-check.
  disabledPaths: ["/organization/list-invitations"],
  emailAndPassword: {
    enabled: true,
    revokeSessionsOnPasswordReset: true,
    // Invite-only on hosted Cloudflare; self-host stays open.
    disableSignUp: IS_CLOUDFLARE,
  },
  // Route OAuth authorization-code (and other single-use verification)
  // consume through the DB-atomic `runWithTransaction` + `consumeOne` path
  // (better-auth/db/internal-adapter.mjs:671-697) instead of the cache-only
  // get-then-delete branch (line 642-664). KV `secondaryStorage` here has
  // no `getAndDelete` and BA's fallback lock is per-isolate Map-based, so
  // without this flag two concurrent requests for the same auth code on
  // different Workers isolates could each mint an access token
  // (RFC 6749 §4.1.2 violation). KV continues to serve as a read cache for
  // non-consume verification lookups.
  verification: {
    storeInDatabase: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
    // BA writes every session to Drizzle AND KV. Required for oauthProvider
    // (which throws at boot without DB-backed sessions). KV is the per-POP
    // read cache; Drizzle is the durable store. NOTE: BA's `findSession`
    // returns from KV without DB validation on cache hit
    // (internal-adapter.mjs:222-241), so revoked sessions remain valid for
    // the KV delete propagation window (~60s globally) on other POPs.
    // Mitigated by `revokeSessionsOnPasswordReset` + explicit `delete()` on
    // sign-out; absolute revocation requires DB-source-of-truth re-check at
    // the route layer, which is intentionally out of scope here.
    storeSessionInDatabase: true,
    // Explicit defensive disable per better-auth#4203: cookieCache +
    // secondaryStorage forces re-login on cookie expiry. BA's current
    // default is already false; lock it so a future default flip cannot
    // regress the KV-backed session-cache path.
    cookieCache: { enabled: false },
  },
  rateLimit: {
    enabled: true,
    window: 10,
    max: 100,
    storage: "memory",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
    },
  },
  trustedOrigins: process.env.BETTER_AUTH_URL
    ? [process.env.BETTER_AUTH_URL]
    : [],
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production" || IS_CLOUDFLARE,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
    },
    database: {
      generateId: false,
    },
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
    },
  },
  // organization() must precede any future customSession() — see
  // better-auth issue #3233 (activeOrganizationId is type-erased otherwise).
  plugins: [
    jwt(),
    organization({
      ac,
      roles: { owner, admin, member: memberRole },
      organizationHooks: {
        afterAddMember: async ({ member: added, organization: org }) => {
          await grantOrgAccess(added.userId, org.id);
        },
        afterAcceptInvitation: async ({ member: added, organization: org }) => {
          await grantOrgAccess(added.userId, org.id);
        },
        afterRemoveMember: async ({ member: removed, organization: org }) => {
          const results = await Promise.allSettled([
            clearOrgMembershipArtifacts(removed.userId, org.id),
            revokeOrgAccess(removed.userId, org.id),
          ]);
          for (const r of results) {
            if (r.status === "rejected") {
              console.error("afterRemoveMember cleanup failure", {
                userId: removed.userId,
                orgId: org.id,
                err: r.reason,
              });
            }
          }
        },
        beforeDeleteOrganization: async ({ organization: org }) => {
          const userIds = await findOrgMemberUserIdsAsAdmin(org.id);
          const tasks = userIds.flatMap((userId) => [
            {
              step: "clearOrgMembershipArtifacts" as const,
              userId,
              run: () => clearOrgMembershipArtifacts(userId, org.id),
            },
            {
              step: "revokeOrgAccess" as const,
              userId,
              run: () => revokeOrgAccess(userId, org.id),
            },
          ]);
          const results = await Promise.allSettled(tasks.map((t) => t.run()));
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === "rejected") {
              console.error("beforeDeleteOrganization cleanup failure", {
                step: tasks[i].step,
                userId: tasks[i].userId,
                orgId: org.id,
                err: r.reason,
              });
            }
          }
        },
      },
    }),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      accessTokenExpiresIn: 60 * 60, // 1h
      refreshTokenExpiresIn: 60 * 60 * 24 * 7, // 7 days
      clientRegistrationAllowedScopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
      ],
      validAudiences: process.env.BETTER_AUTH_URL
        ? [
            process.env.BETTER_AUTH_URL,
            `${process.env.BETTER_AUTH_URL}/api/mcp`,
          ]
        : ["http://localhost:3000", "http://localhost:3000/api/mcp"],
      // MCP tokens are intentionally org-agnostic. Team scope is resolved
      // per request: read paths span every team the caller belongs to,
      // writes either name an explicit `organizationId` (membership-checked)
      // or auto-resolve when the caller is in exactly one team. There is no
      // `active_org` claim — that conflated identity with destination and
      // let stale tokens write into teams the user had been removed from.
      // `consentReferenceId` returns undefined so BA does not stamp a
      // referenceId on the token.
      postLogin: {
        page: "/onboarding/team",
        consentReferenceId: () => undefined,
        shouldRedirect: () => false,
      },
      silenceWarnings: { oauthAuthServerConfig: true },
    }),
  ],
  databaseHooks: {
    account: {
      update: {
        after: async (account) => {
          if (account.providerId !== "credential") return;
          try {
            await clearUserOAuthArtifacts(account.userId);
          } catch (err) {
            console.error("account.update.after cascade failure", {
              userId: account.userId,
              err,
            });
          }
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
