"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { requireLegalConsent } from "@/lib/auth/consent";
import { getSession, requireSession } from "@/lib/auth/session";
import { isEmailEnabled } from "@/lib/email";
import {
  checkActionIpRateLimit,
  checkActionRateLimit,
  checkActionUserRateLimit,
  type ActionRateLimitConfig,
} from "@/lib/actions/rate-limit-action";
import {
  mapBetterAuthError,
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from "@/lib/actions/team-errors";
import { exportAccountData, type AccountExport } from "@/lib/data/account";

const NAME_MAX = 80;

const updateProfileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(NAME_MAX),
});

/**
 * Update the signed-in user's display name. Email changes go through
 * `changeEmailAction` instead: they require the verification round-trip
 * Better Auth mandates plus a current-password re-entry gate.
 *
 * @param input - `{ name }` from the profile form.
 * @returns Discriminated `TeamActionResult`.
 */
export async function updateProfileAction(input: {
  name: string;
}): Promise<TeamActionResult> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  await requireLegalConsent(userId);

  const parsed = parseOrFail(updateProfileSchema, input);
  if (!parsed.ok) return parsed;

  const limit = await checkActionRateLimit(
    {
      action: "profile.update",
      windowSeconds: 60,
      perUserMax: 10,
      perIpMax: 30,
    },
    userId,
  );
  if (!limit.ok) return teamFail("rate_limited");

  try {
    await auth.api.updateUser({
      body: { name: parsed.data.name },
      headers: await headers(),
    });
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("updateProfileAction failed", err);
    }
    return teamFail(code);
  }

  revalidatePath("/settings");
  return { ok: true };
}

const EMAIL_MAX = 254;
const PASSWORD_MAX = 128;

// Same per-PoP `auth` binding and 5/60 bounds as the password action: the
// current-password verify is the same scrypt brute-force surface, and any
// larger declared value would be silently rewritten to 5 on Workers.
const CHANGE_EMAIL_RATE_LIMIT: ActionRateLimitConfig = {
  action: "email.change",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 5,
  backendKind: "auth",
};

const changeEmailSchema = z.object({
  newEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(EMAIL_MAX, "Enter a valid email address")
    .pipe(z.email("Enter a valid email address")),
  // Bounded to BA's max so an oversized value cannot amplify the scrypt
  // verify cost per attempt (see changePasswordSchema).
  currentPassword: z
    .string()
    .min(1, "Current password is required")
    .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`),
});

/**
 * Start the signed-in user's email change. Enforces current-password
 * re-entry via `auth.api.verifyPassword`, then dispatches
 * `auth.api.changeEmail`, which emails an approval link to the CURRENT
 * address; the switch completes only after the new address is verified
 * (OWASP change-email flow, wired in `lib/auth.ts`). Server-action-only
 * initiation: the HTTP `/change-email` route is default-denied by the auth
 * catch-all allowlist, so throttling lives in the two rate-limit limbs
 * below, counted against the per-PoP `auth` binding in flood-safe order.
 * Responds uniformly for taken and available target addresses (Better
 * Auth's built-in anti-enumeration).
 *
 * @param input - `{ newEmail, currentPassword }` from the settings form.
 * @returns Discriminated `TeamActionResult`; `invalid_password` when the
 *          current password does not verify, `email_not_configured` when
 *          this deployment cannot send the approval email.
 */
export async function changeEmailAction(input: {
  newEmail: string;
  currentPassword: string;
}): Promise<TeamActionResult> {
  const ipLimit = await checkActionIpRateLimit(CHANGE_EMAIL_RATE_LIMIT);
  if (!ipLimit.ok) return teamFail("rate_limited");

  let user: { id: string; email: string };
  try {
    const session = await getSession();
    // getSession returns null for a missing session and throws only on
    // infrastructure failure; a DB hiccup during a credential flow must not
    // masquerade as "you must be signed in".
    if (!session) return teamFail("unauthorized");
    user = session.user;
  } catch (err) {
    console.error("changeEmailAction session lookup failed", err);
    return teamFail("unknown");
  }
  await requireLegalConsent(user.id);

  const parsed = parseOrFail(changeEmailSchema, input);
  if (!parsed.ok) return parsed;

  const userLimit = await checkActionUserRateLimit(
    CHANGE_EMAIL_RATE_LIMIT,
    user.id,
  );
  if (!userLimit.ok) return teamFail("rate_limited");

  if (!isEmailEnabled()) return teamFail("email_not_configured");
  if (parsed.data.newEmail === user.email.toLowerCase()) {
    return teamFail("invalid_input");
  }

  try {
    await auth.api.verifyPassword({
      body: { password: parsed.data.currentPassword },
      headers: await headers(),
    });
    await auth.api.changeEmail({
      body: { newEmail: parsed.data.newEmail, callbackURL: "/settings" },
      headers: await headers(),
    });
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("changeEmailAction failed", err);
    }
    return teamFail(code);
  }

  revalidatePath("/settings");
  return { ok: true };
}

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(256).optional(),
});

/**
 * Delete the signed-in user's account (GDPR Art. 17). Rate-limited, then
 * dispatched through Better Auth's `auth.api.deleteUser`, whose
 * `beforeDelete` hook (lib/auth.ts) blocks the sole-owner-with-members
 * case, cascade-deletes solely-owned memberless teams, and anonymizes the
 * caller's retained legal-acceptance evidence before the FK cascade wipes
 * sessions, accounts, memberships, and owned content. Re-authentication
 * gate: a supplied password is verified by Better Auth; without one, the
 * session must be younger than `freshAge`, otherwise `session_not_fresh`
 * is returned so the dialog can prompt for password or re-login. On
 * email-capable deploys Better Auth emails a confirmation link instead of
 * deleting immediately (a supplied password still only re-authenticates);
 * `verificationEmailSent` tells the dialog which flow ran.
 *
 * @param input - Optional `{ password }` for credential-account holders.
 * @returns Discriminated `TeamActionResult` carrying
 *          `{ verificationEmailSent }`; `cannot_delete_sole_owner` when an
 *          owned team must be handed off first.
 */
export async function deleteAccountAction(input?: {
  password?: string;
}): Promise<TeamActionResult<{ verificationEmailSent: boolean }>> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(deleteAccountSchema, input ?? {});
  if (!parsed.ok) return parsed;

  const limit = await checkActionRateLimit(
    {
      action: "account.delete",
      windowSeconds: 60,
      perUserMax: 5,
      perIpMax: 10,
    },
    userId,
  );
  if (!limit.ok) return teamFail("rate_limited");

  try {
    const result = await auth.api.deleteUser({
      body: parsed.data.password ? { password: parsed.data.password } : {},
      headers: await headers(),
    });
    return {
      ok: true,
      data: {
        verificationEmailSent: result.message === "Verification email sent",
      },
    };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("deleteAccountAction failed", err);
    }
    return teamFail(code);
  }
}

/**
 * Produce a machine-readable JSON export of the signed-in user's account
 * data (GDPR Art. 15/20). Rate-limited and session-gated; the payload
 * covers profile, team memberships, and the caller's own legal
 * acceptances, each outer-scoped to the caller and excluding shared
 * project/task content. The client serializes the returned data to a
 * downloadable JSON blob.
 *
 * @returns Discriminated `TeamActionResult` carrying the export payload.
 */
export async function exportAccountDataAction(): Promise<
  TeamActionResult<AccountExport>
> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }

  const limit = await checkActionRateLimit(
    {
      action: "account.export",
      windowSeconds: 60,
      perUserMax: 5,
      perIpMax: 10,
    },
    userId,
  );
  if (!limit.ok) return teamFail("rate_limited");

  try {
    const data = await exportAccountData(userId);
    return { ok: true, data };
  } catch (err) {
    console.error("exportAccountDataAction failed", err);
    return teamFail("unknown");
  }
}
