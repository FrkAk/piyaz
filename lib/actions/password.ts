"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/auth/session";
import {
  checkActionIpRateLimit,
  checkActionUserRateLimit,
  type ActionRateLimitConfig,
} from "@/lib/actions/rate-limit-action";
import {
  mapBetterAuthError,
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from "@/lib/actions/team-errors";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

// Per-PoP enforcement on Workers via the auth binding. The default
// "actions" slot is per-isolate memory, which a distributed attacker
// holding a stolen session cookie could sidestep across isolates to
// brute-force the current password. Both limits MUST equal the binding's
// `simple.limit` (5/60): the binding enforces its own limit per key, so
// any larger declared value would be silently rewritten to 5 on Workers
// while self-host enforced the declared number.
const RATE_LIMIT: ActionRateLimitConfig = {
  action: "password.change",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 5,
  backendKind: "auth",
};

const changePasswordSchema = z
  .object({
    // Bound the current password to BA's max so an attacker cannot submit a
    // multi-hundred-KB value to amplify the scrypt verify cost per attempt
    // (BA hashes the new password AND verifies the current one, two scrypt
    // ops, before this value is rejected server-side).
    currentPassword: z
      .string()
      .min(1, "Current password is required")
      .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`),
    newPassword: z
      .string()
      .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
      .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`),
  })
  // A same-value "change" still verifies the current password, re-hashes,
  // and fires revokeOtherSessions + the agent-revocation hook — a
  // disruptive no-op. Refuse it before reaching Better Auth.
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "New password must be different from the current one",
    path: ["newPassword"],
  });

/**
 * Change the signed-in user's password via Better Auth's `changePassword`.
 * Always revokes every other session: BA deletes all sessions and mints a
 * fresh one for this device, whose cookie reaches the browser through the
 * `nextCookies()` plugin in `lib/auth.ts`.
 *
 * The credential-row update triggers the `account.update.after` hook
 * (`lib/auth.ts`), which deletes the user's OAuth access AND refresh tokens.
 * Refresh tokens die immediately (no new agent tokens can be minted). MCP
 * access tokens are stateless JWS verified without DB introspection
 * (`app/api/mcp/route.ts`), so any already-issued one keeps working until
 * its TTL expires (`accessTokenExpiresIn`, 1h) — full agent lockout is
 * within the hour, not instant.
 *
 * Reached only through this server action: the HTTP `/change-password`
 * route is default-denied by the auth catch-all allowlist
 * (`app/api/auth/[...all]/route.ts`), so brute-force throttling lives in
 * the two rate-limit limbs below, counted against the per-PoP `auth`
 * binding in flood-safe order (per-IP before the session lookup, per-user
 * after auth — the `authorizeWrite` pattern in `lib/graph/mutations.ts`).
 *
 * @param input - `{ currentPassword, newPassword }` from the password form.
 * @returns Discriminated `TeamActionResult`; `invalid_password` when the
 *          current password does not verify.
 */
export async function changePasswordAction(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<TeamActionResult> {
  const ipLimit = await checkActionIpRateLimit(RATE_LIMIT);
  if (!ipLimit.ok) return teamFail("rate_limited");

  let userId: string;
  try {
    const session = await getSession();
    // getSession returns null for a missing session and throws only on
    // infrastructure failure (DB outage, headers error). Distinguishing
    // them structurally keeps a DB hiccup during a credential flow from
    // masquerading as "you must be signed in".
    if (!session) return teamFail("unauthorized");
    userId = session.user.id;
  } catch (err) {
    console.error("changePasswordAction session lookup failed", err);
    return teamFail("unknown");
  }

  const parsed = parseOrFail(changePasswordSchema, input);
  if (!parsed.ok) return parsed;

  const userLimit = await checkActionUserRateLimit(RATE_LIMIT, userId);
  if (!userLimit.ok) return teamFail("rate_limited");

  try {
    await auth.api.changePassword({
      body: {
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        revokeOtherSessions: true,
      },
      headers: await headers(),
    });
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("changePasswordAction failed", err);
    }
    return teamFail(code);
  }

  revalidatePath("/settings");
  return { ok: true };
}
