import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { captcha, organization, jwt } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as authSchema from "@/lib/db/auth-schema";
import { authDb } from "@/lib/db/connection";
import {
  clearOrgMembershipArtifacts,
  deleteSoleMemberOrgAsAdmin,
  enumerateOwnedOrgsForDeletion,
  planOwnedOrgDeletion,
  scrubLegalAcceptances,
} from "@/lib/data/account";
import { TEAM_ACTION_MESSAGES } from "@/lib/actions/team-errors";
import { clearUserOAuthArtifacts } from "@/lib/data/oauth-session";
import { ac, owner, admin, member as memberRole } from "@/lib/auth/permissions";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/auth/password-policy";
import { ACCESS_TOKEN_TTL_SECONDS } from "@/lib/auth/token-policy";
import {
  countOwnedOrganizations,
  findOrgMemberUserIdsAsAdmin,
} from "@/lib/data/membership";
import { grantOrgAccess, revokeOrgAccess } from "@/lib/realtime/access";
import { getKvSecondaryStorage } from "@/lib/db/_auth-kv-storage";
import { logAuthApiError } from "@/lib/auth/api-error-log";
import {
  emailVerificationRequired,
  signupsDisabled,
  turnstileConfigured,
} from "@/lib/config/env";
import {
  checkRecipientDomain,
  recipientDomain,
} from "@/lib/auth/recipient-domain";
import { isEmailConfiguredAtBoot } from "@/lib/email";
import {
  sendChangeEmailApprovalEmail,
  sendDeleteAccountEmail,
  sendNewSignInEmail,
  sendPasswordChangedEmail,
  sendResetPasswordEmail,
  sendTeamInviteEmail,
  sendVerificationEmail,
  type SignInContext,
} from "@/lib/auth/emails";
import { recordAcceptance, removeAcceptances } from "@/lib/data/legal";
import { getOutstandingConsent } from "@/lib/auth/consent";
import { describeReconsentDocuments } from "@/lib/legal/versions";
import { clientIpFromHeaders } from "@/lib/actions/rate-limit-action";
import {
  addressPolicyError,
  hasTrustedAddressSource,
  INTERNAL_CLIENT_IP_HEADER,
  IPV6_SUBNET_BITS,
  UNTRUSTED_BUDGET_FACTOR,
} from "@/lib/security/client-ip";

const IS_CLOUDFLARE = process.env.DEPLOY_TARGET === "cloudflare";

/**
 * Which request header Better Auth may read the client address from.
 *
 * The address keys the credential-path rate limiters and is persisted as
 * `session.ipAddress` and legal-acceptance evidence, so a caller that can set
 * it defeats brute-force throttling and authors its own audit record. The list
 * carries exactly {@link INTERNAL_CLIENT_IP_HEADER}, which `stampClientIpHeader`
 * fills from `resolveClientIp` in middleware and in every route that calls
 * `auth.handler`, so Better Auth and the middleware limiter name the same
 * caller by construction. The stamped value is already masked; `normalizeIP`
 * is idempotent at the same width. An empty stamp resolves no address and
 * falls back to one shared per-path bucket (in NODE_ENV=development Better
 * Auth substitutes `127.0.0.1`).
 *
 * @returns The `advanced.ipAddress` policy for this deployment.
 */
function ipAddressPolicy(): {
  ipAddressHeaders: string[];
  ipv6Subnet: number;
} {
  return {
    ipAddressHeaders: [INTERNAL_CLIENT_IP_HEADER],
    ipv6Subnet: IPV6_SUBNET_BITS,
  };
}

/**
 * Per-path credential budgets for Better Auth's own limiter.
 *
 * Function-form rules, evaluated per request after the bucket key is computed:
 * when {@link INTERNAL_CLIENT_IP_HEADER} carries no address, the request lands
 * on the shared per-path bucket, and the budget widens by
 * {@link UNTRUSTED_BUDGET_FACTOR} only where the deployment declares no
 * address source at all — an instance that cannot attribute anyone must not
 * let one caller pin a caller-sized budget on an instance-wide bucket. Where
 * a source is declared, an unattributable request keeps the tight budget.
 * Kept in step with `effectiveMax`, which widens on the same two conditions.
 *
 * @returns The `rateLimit.customRules` map for this deployment.
 */
export function authRateLimitRules(): Record<
  string,
  (request: Request) => { window: number; max: number }
> {
  const perAddress =
    (max: number) =>
    (request: Request): { window: number; max: number } => {
      const widen =
        !request.headers.get(INTERNAL_CLIENT_IP_HEADER) &&
        !hasTrustedAddressSource();
      return {
        window: 60,
        max: widen ? max * UNTRUSTED_BUDGET_FACTOR : max,
      };
    };
  return {
    "/sign-in/email": perAddress(5),
    "/sign-up/email": perAddress(3),
    "/request-password-reset": perAddress(3),
    "/send-verification-email": perAddress(3),
    "/reset-password": perAddress(5),
  };
}

/** Ceiling on how many organizations a single user may own. Enforced at
 *  organization-create time in the un-bypassable `/organization/*` hook. */
const MAX_OWNED_ORGANIZATIONS = 10;

/** Ceiling on members per organization, passed to Better Auth's
 *  `organization` plugin instead of relying on the library default. */
const ORGANIZATION_MEMBERSHIP_LIMIT = 50;

/**
 * Canonical set of OAuth scopes this provider grants. Single source of
 * truth for both what dynamically-registered clients may request
 * (`clientRegistrationAllowedScopes`) and what the authorization-server
 * metadata advertises (`advertisedMetadata.scopes_supported`), so the two
 * cannot drift. `offline_access` gates refresh-token issuance (#108).
 */
export const GRANTABLE_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;

/**
 * Endpoints the Turnstile captcha plugin guards.
 *
 * Every path here either mails an attacker-chosen address or re-mails a
 * victim's, which is the abuse surface a bot signup exercises. Named
 * explicitly rather than relying on the plugin's defaults, because those omit
 * `/send-verification-email` (a direct mail trigger) and because Better Auth
 * 1.6.23 matches these by substring, not exact path, so an implicit list is a
 * silent over-match waiting to happen.
 *
 * Substring matching is why `/sign-in` alone is unsafe to list. Of the four
 * below, three collide with a longer path: `/sign-in/email` with
 * `/sign-in/email-otp`, and `/request-password-reset` with both
 * `/email-otp/request-password-reset` and
 * `/phone-number/request-password-reset`. Better Auth exempts only the first
 * of those internally, and this deployment enables neither the `emailOTP` nor
 * the `phoneNumber` plugin, so none of the three is reachable. Adding
 * either plugin would gate its paths as a side effect.
 *
 * Better Auth 1.7 switches to exact-and-wildcard matching and drops the
 * built-in email-otp exemption. Because this list is four exact paths with no
 * wildcard, that upgrade is a no-op here: every entry keeps matching exactly
 * what it matches today, and nothing new becomes gated.
 *
 * Exported so the test iterates the real list instead of a copy, which is what
 * makes a newly added endpoint fail loudly rather than silently go uncovered.
 */
export const CAPTCHA_PROTECTED_ENDPOINTS = [
  "/sign-up/email",
  "/sign-in/email",
  "/send-verification-email",
  "/request-password-reset",
] as const;

/**
 * Hostname pin for captcha tokens.
 *
 * Turnstile reports the hostname a token was solved on, so pinning it stops a
 * token minted against the dev widget from being replayed at prod. The pin is
 * silently inert if the option is omitted, so an unusable `BETTER_AUTH_URL`
 * says so rather than leaving bot protection looking armed while cross-origin
 * replay works. Unreachable on the Cloudflare target, which refuses to boot
 * without `BETTER_AUTH_URL`.
 *
 * @returns The single allowed hostname, or `undefined` when none can be
 *   derived, which leaves the plugin's hostname check disabled.
 */
function captchaAllowedHostnames(): string[] | undefined {
  const url = process.env.BETTER_AUTH_URL;
  try {
    if (url) return [new URL(url).hostname];
  } catch {
    // Fall through to the warning below.
  }
  console.warn(
    JSON.stringify({
      event: "turnstile_hostname_pin_absent",
      hint: "BETTER_AUTH_URL is unset or unparseable, so captcha tokens are not pinned to this deployment's hostname and a token minted elsewhere would verify here.",
    }),
  );
  return undefined;
}

/**
 * Recipient domains rejected at sign-up because they provably cannot receive
 * mail. Message is deliberately about the address, not about bot protection.
 */
const UNDELIVERABLE_DOMAIN_MESSAGE =
  "That email domain cannot receive mail. Check the address and try again.";

if (IS_CLOUDFLARE && !process.env.BETTER_AUTH_URL) {
  throw new Error(
    "BETTER_AUTH_URL is required on the Cloudflare deploy target. " +
      "It is the issuer, the audience and the resource-metadata URL the MCP " +
      "route derives at module load, so without it all three pin to the " +
      "http://localhost:3000 fallback and every MCP token fails audience and " +
      "issuer validation. Set it in wrangler.jsonc env.production.vars.",
  );
}

// Runtime only. `next build` forces NODE_ENV=production and evaluates this
// module while collecting page data, but the value is read per request and
// never inlined, so a build does not need it. Requiring it there would break
// building an image or artifact separately from deploying it (see Dockerfile),
// while catching nothing: `instrumentation.ts` refuses a self-host boot
// without it on every launch path (`scripts/start.mjs` additionally refuses
// before the socket binds), and this catches a malformed value on first use.
if (
  !IS_CLOUDFLARE &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  const policyError = addressPolicyError();
  if (policyError) throw new Error(policyError);
}

/**
 * Extract the security-notification display context from a Better Auth
 * callback request. Absent request (server-action dispatch via `auth.api.*`
 * carries headers only in hooks, none in option callbacks) yields empty
 * context; the templates omit the corresponding notes.
 *
 * @param request - The originating request, when Better Auth forwards one.
 * @returns Device (user-agent) and location (client IP) display strings.
 */
function requestSignInContext(request?: Request): SignInContext {
  if (!request) return {};
  return {
    device: request.headers.get("user-agent") ?? undefined,
    location: clientIpFromHeaders(request.headers) ?? undefined,
  };
}

/**
 * Whether any of the user's other live sessions matches the new session's
 * user-agent AND IP address. Recognition gate for the new-sign-in
 * notification: a match means a familiar context, so no mail. `IS NOT
 * DISTINCT FROM` treats missing values as equal, so two proxied sessions
 * without an IP compare as matching rather than alerting on every sign-in.
 * Runs inline (not in the floating send): the Workers request-scoped DB
 * client is torn down when the response completes.
 *
 * @param userId - The signing-in user.
 * @param newSessionId - The just-created session to exclude.
 * @param userAgent - The new session's user-agent, if recorded.
 * @param ipAddress - The new session's client IP, if recorded.
 * @returns `true` when a matching other session exists.
 */
async function hasMatchingOtherSession(
  userId: string,
  newSessionId: string,
  userAgent: string | null,
  ipAddress: string | null,
): Promise<boolean> {
  const rows = await authDb
    .select({ id: authSchema.session.id })
    .from(authSchema.session)
    .where(
      and(
        eq(authSchema.session.userId, userId),
        ne(authSchema.session.id, newSessionId),
        gt(authSchema.session.expiresAt, new Date()),
        sql`${authSchema.session.userAgent} IS NOT DISTINCT FROM ${userAgent}`,
        sql`${authSchema.session.ipAddress} IS NOT DISTINCT FROM ${ipAddress}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Build the Better Auth server instance with email/password auth,
 * organization-based team management, and the email flows (verification,
 * reset, change-email, delete confirmation, security notifications). Adapts
 * the `piyaz_auth` schema via drizzleAdapter. A factory so tests can
 * construct instances under different boot-time env (verification gate,
 * email capability); production uses the {@link auth} singleton.
 *
 * @returns A configured Better Auth instance.
 */
export function createAuth() {
  return betterAuth({
    database: drizzleAdapter(authDb, {
      provider: "pg",
      schema: authSchema,
    }),
    secret: process.env.BETTER_AUTH_SECRET,
    secondaryStorage: getKvSecondaryStorage(),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      requireEmailVerification: emailVerificationRequired(),
      revokeSessionsOnPasswordReset: true,
      disableSignUp: signupsDisabled(),
      sendResetPassword: sendResetPasswordEmail,
      resetPasswordTokenExpiresIn: 3600,
      onPasswordReset: async ({ user }, request) => {
        sendPasswordChangedEmail(user, requestSignInContext(request));
      },
    },
    // Delivery is independently gated per send: getEmailSender() null makes
    // every callback a no-op. sendOnSignUp/sendOnSignIn follow the explicit
    // verification gate, never transport availability: with EMAIL_TRANSPORT=log
    // and no gate, self-host users stay unverified forever and an ungated
    // sendOnSignIn would mail (or stdout-log) every single sign-in.
    emailVerification: {
      sendVerificationEmail,
      sendOnSignUp: emailVerificationRequired(),
      sendOnSignIn: emailVerificationRequired(),
      autoSignInAfterVerification: true,
      expiresIn: 3600,
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
      // Default freshness stays enabled: deleteUser without a password
      // requires a session younger than `freshAge` (BA throws SESSION_EXPIRED
      // otherwise), and a supplied password bypasses the freshness check.
      // deleteAccountAction forwards an optional password, so credential
      // users confirm with it and social-login users rely on a recent
      // sign-in; a stale session surfaces `session_not_fresh` to the dialog.
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
    // BA's default router logging is message-only; 5xx throw sites on
    // /api/auth/* are untraceable without the stack + cause chain.
    onAPIError: {
      onError: logAuthApiError,
    },
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      // Deliberate override: Better Auth would pick "secondary-storage"
      // because one is configured, but the KV adapter has no atomic increment
      // and KV allows one write per second per key. Memory bounds per
      // process; the Cloudflare bindings in `lib/api/rate-limit.ts` enforce
      // across isolates.
      storage: "memory",
      customRules: authRateLimitRules(),
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
      ipAddress: ipAddressPolicy(),
    },
    // organization() must precede any future customSession() — see
    // better-auth issue #3233 (activeOrganizationId is type-erased otherwise).
    plugins: [
      jwt(),
      // Bot protection on the mail-triggering auth endpoints. Registered only
      // when a secret is configured so self-host stays bootable without a
      // Cloudflare account; see `turnstileConfigured`. Placed before
      // `nextCookies()`, which must stay last.
      //
      // The plugin forwards the caller's address to siteverify as `remoteip`,
      // taken from `advanced.ipAddress`. That resolver masks IPv6 to a /64, so
      // an IPv6 visitor's `remoteip` is their network, not their address.
      // Cloudflare documents `remoteip` as optional with no mismatch handling,
      // so this costs signal quality rather than correctness, and 1.6.23
      // offers no per-call opt-out short of disabling IP tracking globally,
      // which would also widen every rate-limit bucket.
      ...(turnstileConfigured()
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: process.env.TURNSTILE_SECRET_KEY!,
              endpoints: [...CAPTCHA_PROTECTED_ENDPOINTS],
              allowedHostnames: captchaAllowedHostnames(),
            }),
          ]
        : []),
      organization({
        ac,
        membershipLimit: ORGANIZATION_MEMBERSHIP_LIMIT,
        roles: { owner, admin, member: memberRole },
        // generateId:false (advanced.database above) would otherwise flip
        // BA's verified-email requirement ON for get/accept/reject-invitation,
        // locking out every unverified account (all of self-host). Verification
        // enforcement is owned by the sign-in gate, not the invite flow.
        requireEmailVerificationOnInvitation: false,
        sendInvitationEmail: sendTeamInviteEmail,
        organizationHooks: {
          afterAddMember: async ({ member: added, organization: org }) => {
            await grantOrgAccess(added.userId, org.id);
          },
          afterAcceptInvitation: async ({
            member: added,
            organization: org,
          }) => {
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
        // The revocation lag, not the session length: `/api/mcp` verifies by
        // signature alone and never reads revocation state, and revoking a
        // session marks the refresh token revoked
        // (`lib/data/oauth-session.ts`), so the outstanding access token is
        // the entire exposure. Shortening it forces refresh-token-less
        // clients to re-authorize that often; closing the gap needs the
        // resource server to consult revocation state (see `verifyMcpAuth`).
        // The Settings revocation copy derives from the shared constant.
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenExpiresIn: 60 * 60 * 24 * 7, // 7 days
        clientRegistrationAllowedScopes: [...GRANTABLE_OAUTH_SCOPES],
        // Advertise the grantable scopes in the authorization-server metadata
        // (`/.well-known/oauth-authorization-server`), which is what a generic
        // OAuth client and the consent screen read. An MCP client's scope
        // selection reads the 401 `scope` challenge first and the
        // PROTECTED RESOURCE metadata second, so refresh-token issuance (#108)
        // is driven by the challenge in `app/api/mcp/route.ts`, not by this
        // list. Protected-resource metadata deliberately omits
        // `offline_access`, which the spec says resources SHOULD NOT advertise.
        advertisedMetadata: {
          scopes_supported: [...GRANTABLE_OAUTH_SCOPES],
        },
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
      // MUST stay last (BA Next.js integration requirement): forwards BA's
      // Set-Cookie into Next's cookie store for server actions. Without it,
      // changePassword({ revokeOtherSessions: true }) deletes every session
      // and the rotated cookie never reaches the browser, signing the user
      // out after a successful change. tests/auth/change-password pins
      // presence and ordering only; the actual store forwarding cannot run
      // under bun (no Next request scope) and was verified manually against
      // the dev server (MYMR-235).
      nextCookies(),
    ],
    user: {
      // Initiation is server-action-only (changeEmailAction verifies the
      // current password first); /change-email is not in the route allowlist.
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: sendChangeEmailApprovalEmail,
      },
      deleteUser: {
        enabled: true,
        // Presence alone flips /delete-user from immediate deletion to the
        // emailed-confirmation flow (a supplied password only re-authenticates),
        // so the callback must be absent on email-incapable deploys or account
        // deletion becomes impossible. Boot-safe signal: BA reads options once
        // at construction, before any request-scoped binding exists.
        ...(isEmailConfiguredAtBoot()
          ? { sendDeleteAccountVerification: sendDeleteAccountEmail }
          : {}),
        // Runs while `user.id` is still populated (before the row is
        // removed), which the legal-acceptance scrub requires. Ordered:
        // (1) block deletion when the caller solely owns a team that still
        // has other members — they must transfer or delete it first;
        // (2) cascade-delete teams the caller is the only member of so none
        // is orphaned; (3) anonymize retained legal-acceptance evidence.
        // Unlike beforeDeleteOrganization (which allSettles and logs), the
        // sole-owner guard and the scrub THROW to abort the whole delete so
        // a failure never leaves an ownerless team or a compliance gap.
        // These steps are not transactional with the user-row delete: a
        // scrub failure aborts after memberless teams are already gone,
        // which is acceptable because only the deleting user could see them.
        beforeDelete: async (user) => {
          const plan = planOwnedOrgDeletion(
            await enumerateOwnedOrgsForDeletion(user.id),
          );
          if (plan.kind === "blocked") {
            throw new APIError("BAD_REQUEST", {
              message: TEAM_ACTION_MESSAGES.cannot_delete_sole_owner,
              code: "CANNOT_DELETE_SOLE_OWNER",
            });
          }
          if (plan.orgIdsToDelete.length > 0) {
            // The reentrant auth.api.deleteOrganization path needs the request
            // context that server-action dispatch (auth.api.deleteUser with
            // headers only) never carries, so the cascade runs the audited
            // pieces directly: the same per-member cleanup the org-delete hook
            // performs (the deleting owner is the only member by
            // planOwnedOrgDeletion's definition), then the org row, whose FK
            // cascade wipes projects, tasks, edges, invitations, and the
            // member row.
            for (const organizationId of plan.orgIdsToDelete) {
              try {
                await clearOrgMembershipArtifacts(user.id, organizationId);
                await revokeOrgAccess(user.id, organizationId);
                await deleteSoleMemberOrgAsAdmin(organizationId, user.id);
              } catch (err) {
                console.error("deleteUser.beforeDelete cleanup failure", {
                  userId: user.id,
                  orgId: organizationId,
                  step: "deleteOwnedOrg",
                  err,
                });
                throw err;
              }
            }
          }
          try {
            await scrubLegalAcceptances(user.id);
          } catch (err) {
            console.error("deleteUser.beforeDelete cleanup failure", {
              userId: user.id,
              step: "scrubLegalAcceptances",
              err,
            });
            throw err;
          }
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Gate every account-creation path on affirmative Terms consent.
          // Runs for `auth.api.signUpEmail` and a raw POST to
          // `/api/auth/sign-up/email` alike, so the gate cannot be bypassed by
          // skipping the client checkbox. `termsAccepted` is a transient consent
          // signal read off the request body; the durable evidence is the
          // `legal_acceptances` rows written in `after`.
          before: async (_user, ctx) => {
            const body = ctx?.body as { termsAccepted?: unknown } | undefined;
            if (body?.termsAccepted !== true) {
              throw new APIError("BAD_REQUEST", {
                message:
                  "You must accept the Terms of Service to create an account.",
                code: "TERMS_NOT_ACCEPTED",
              });
            }
          },
          // Persist compliance evidence: one `terms` and one `privacy` row, each
          // carrying the current LEGAL_VERSIONS version, timestamp, resolved IP,
          // and user-agent. Must be `after` (not `before`): the rows FK to the
          // user, which does not exist until creation commits. On write failure,
          // compensate by deleting the just-created user so no account survives
          // without its acceptance evidence; a throw here does NOT roll the user
          // back (the row is already committed when `after` runs).
          after: async (user, ctx) => {
            const requestHeaders = ctx?.headers;
            const ipAddress = requestHeaders
              ? clientIpFromHeaders(requestHeaders)
              : null;
            const userAgent = requestHeaders?.get("user-agent") ?? null;
            try {
              await recordAcceptance(user.id, "terms", {
                ipAddress,
                userAgent,
              });
              await recordAcceptance(user.id, "privacy", {
                ipAddress,
                userAgent,
              });
            } catch (err) {
              console.error("user.create.after acceptance-write failure", {
                userId: user.id,
                err,
              });
              try {
                // Remove any row that already committed (the FK on the user
                // delete would only null user_id, stranding unattributable
                // evidence), then the user itself.
                await removeAcceptances(user.id);
                await ctx?.context.internalAdapter.deleteUser(user.id);
              } catch (cleanupErr) {
                console.error("user.create.after compensating delete failed", {
                  userId: user.id,
                  err: cleanupErr,
                });
              }
              throw new APIError("INTERNAL_SERVER_ERROR", {
                message: "Could not record your acceptance. Please try again.",
              });
            }
          },
        },
      },
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
    hooks: {
      // Two gates on the organization plugin's endpoints, which ride the
      // better-auth catch-all and so bypass the app's route-level consent
      // gate. Global endpoint hooks (unlike organizationHooks) receive the
      // full request ctx (body, headers, returned value) and run for
      // `auth.api.*` calls and raw POSTs to `/api/auth/organization/*` alike,
      // so neither gate can be skipped by avoiding the web client.
      // 1. Re-consent: every /organization/* endpoint is real tenant
      //    read/write surface (list, members, invites, update, delete); a
      //    caller with outstanding personal documents is blocked like on
      //    /api routes. Reads through the request-cached `getOutstandingConsent`
      //    so the web-action path (createTeamAction already gated its own read)
      //    shares one query; a raw POST outside a React scope pays one read.
      // 2. DPA at create: `dpaAccepted` is a transient consent signal read
      //    off the request body; the durable evidence is the
      //    `legal_acceptances` row written in `after`.
      before: createAuthMiddleware(async (ctx) => {
        // Reject sign-ups whose domain provably cannot receive mail before the
        // account exists and before a send is attempted. A single such address
        // costs five delivery failures (Cloudflare retries the send) and lands
        // on the account suppression list, which is scored against the <2%
        // hard-bounce target for every other recipient. Endpoint-scoped rather
        // than hung off `databaseHooks.user.create`, because that also fires
        // for provider-verified addresses on non-credential paths.
        if (ctx.path === "/sign-up/email") {
          // Skip the network probe when the endpoint will reject anyway.
          if (signupsDisabled()) return;
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          // `recipientDomain` returns null for anything unprobeable, including
          // a domain past the RFC 1035 length limit; it owns that bound so a
          // second caller cannot lose it.
          const domain =
            typeof email === "string" ? recipientDomain(email) : null;
          if (domain !== null) {
            // `unknown` (resolver error, timeout) falls through: a DNS blip
            // must never become a sign-up outage.
            if ((await checkRecipientDomain(domain)) === "undeliverable") {
              throw new APIError("BAD_REQUEST", {
                message: UNDELIVERABLE_DOMAIN_MESSAGE,
                code: "EMAIL_DOMAIN_UNDELIVERABLE",
              });
            }
          }
          return;
        }
        if (!ctx.path.startsWith("/organization/")) return;
        const session = await getSessionFromCtx(ctx);
        if (session) {
          const outstanding = await getOutstandingConsent(session.user.id);
          if (outstanding.length > 0) {
            throw new APIError("FORBIDDEN", {
              message: `The updated Piyaz ${describeReconsentDocuments(outstanding)} must be re-accepted before continuing. Open /legal/accept to review and accept ${outstanding.length > 1 ? "them" : "it"}.`,
              code: "TERMS_ACCEPTANCE_REQUIRED",
            });
          }
        }
        if (ctx.path !== "/organization/create") return;
        if (session) {
          const ownedCount = await countOwnedOrganizations(session.user.id);
          if (ownedCount >= MAX_OWNED_ORGANIZATIONS) {
            throw new APIError("FORBIDDEN", {
              message: TEAM_ACTION_MESSAGES.organization_limit_reached,
              code: "ORGANIZATION_LIMIT_REACHED",
            });
          }
        }
        const body = ctx.body as { dpaAccepted?: unknown } | undefined;
        if (body?.dpaAccepted !== true) {
          throw new APIError("BAD_REQUEST", {
            message: TEAM_ACTION_MESSAGES.dpa_not_accepted,
            code: "DPA_NOT_ACCEPTED",
          });
        }
      }),
      // Persist the DPA evidence row once the organization exists (the row FKs
      // to it). On write failure, compensate by removing the just-created org
      // (same audited sequence as deleteUser.beforeDelete: membership
      // artifacts, realtime grant, then the org row) so no team survives
      // without its acceptance evidence.
      after: createAuthMiddleware(async (ctx) => {
        // Unrecognized-sign-in notification. Keyed on ctx.context.newSession
        // under a /sign-in/email path filter: databaseHooks.session.create.after
        // would also fire on sign-up and post-verification auto-sign-in, and
        // every-login mail trains users to ignore alerts. Fully contained:
        // notification failures never fail the sign-in.
        if (ctx.path === "/sign-in/email") {
          // Email-disabled deploys send nothing here, so skip the recognition
          // query and keep sign-in on its pre-email-flows path unchanged.
          if (!isEmailConfiguredAtBoot()) return;
          const newSession = ctx.context.newSession;
          if (!newSession) return;
          try {
            const device = newSession.session.userAgent ?? null;
            const location = newSession.session.ipAddress ?? null;
            const recognized = await hasMatchingOtherSession(
              newSession.user.id,
              newSession.session.id,
              device,
              location,
            );
            if (!recognized) {
              sendNewSignInEmail(newSession.user, {
                device: device ?? undefined,
                location: location ?? undefined,
              });
            }
          } catch (err) {
            console.error("sign-in notification failure", {
              userId: newSession.user.id,
              err,
            });
          }
          return;
        }
        if (ctx.path !== "/organization/create") return;
        const returned = ctx.context.returned as
          | { id?: unknown; members?: Array<{ userId?: unknown }> }
          | undefined;
        const organizationId =
          typeof returned?.id === "string" ? returned.id : null;
        const ownerUserId = returned?.members?.[0]?.userId;
        const userId = typeof ownerUserId === "string" ? ownerUserId : null;
        if (!organizationId || !userId) return;
        const requestHeaders = ctx.headers;
        try {
          await recordAcceptance(userId, "dpa", {
            ipAddress: requestHeaders
              ? clientIpFromHeaders(requestHeaders)
              : null,
            userAgent: requestHeaders?.get("user-agent") ?? null,
            organizationId,
          });
        } catch (err) {
          console.error("organization/create dpa acceptance-write failure", {
            userId,
            organizationId,
            err,
          });
          try {
            await clearOrgMembershipArtifacts(userId, organizationId);
            await revokeOrgAccess(userId, organizationId);
            await deleteSoleMemberOrgAsAdmin(organizationId, userId);
          } catch (cleanupErr) {
            console.error("organization/create compensating delete failed", {
              userId,
              organizationId,
              err: cleanupErr,
            });
          }
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Could not record your acceptance. Please try again.",
          });
        }
      }),
    },
  });
}

/**
 * The Better Auth server singleton every production caller uses. Boot-time
 * options (verification gate, email capability) are evaluated once here;
 * tests needing different boot env construct their own via {@link createAuth}.
 */
export const auth = createAuth();

export type Session = typeof auth.$Infer.Session;
