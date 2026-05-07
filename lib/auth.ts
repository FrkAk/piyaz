import { betterAuth } from "better-auth";
import { organization, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as authSchema from "@/lib/db/auth-schema";
import { authDb } from "@/lib/db/connection";
import { clearOrgMembershipArtifacts } from "@/lib/data/account";
import { ac, owner, admin, member as memberRole } from "@/lib/auth/permissions";
import { findOrgMemberUserIds } from "@/lib/data/membership";

/**
 * Better Auth server instance.
 * Uses Neon Auth's existing schema (neon_auth) via drizzleAdapter.
 * Provides email/password auth and organization-based team management.
 */
export const auth = betterAuth({
  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: authSchema,
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24,      // 1 day
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
        afterRemoveMember: async ({ member: removed, organization: org }) => {
          await clearOrgMembershipArtifacts(removed.userId, org.id);
        },
        beforeDeleteOrganization: async ({ organization: org }) => {
          const userIds = await findOrgMemberUserIds(org.id);
          await Promise.all(
            userIds.map((userId) => clearOrgMembershipArtifacts(userId, org.id)),
          );
        },
      },
    }),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      validAudiences: process.env.BETTER_AUTH_URL
        ? [process.env.BETTER_AUTH_URL, `${process.env.BETTER_AUTH_URL}/api/mcp`]
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
});

export type Session = typeof auth.$Infer.Session;
