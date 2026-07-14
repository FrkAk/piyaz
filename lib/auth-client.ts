import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { ac, owner, admin, member } from "@/lib/auth/permissions";

/**
 * Better Auth client instance.
 * Auto-discovers API at /api/auth (same origin).
 * Mirrors the server's access-control statement so
 * `authClient.organization.checkRolePermission` evaluates the same project
 * resource policy on the client.
 */
export const authClient = createAuthClient({
  plugins: [
    organizationClient({ ac, roles: { owner, admin, member } }),
    oauthProviderClient(),
  ],
});

export const {
  useSession,
  signIn,
  signUp,
  signOut,
  sendVerificationEmail,
  requestPasswordReset,
  resetPassword,
} = authClient;
