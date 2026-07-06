"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { requireSession } from "@/lib/auth/session";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
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
 * Update the signed-in user's display name. Email changes are not supported
 * here — Better Auth requires a verification round-trip for email and we
 * lock that path in v1.
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

/**
 * Delete the signed-in user's account (GDPR Art. 17). Rate-limited, then
 * dispatched through Better Auth's `auth.api.deleteUser`, whose
 * `beforeDelete` hook (lib/auth.ts) blocks the sole-owner-with-members
 * case, cascade-deletes solely-owned memberless teams, and anonymizes the
 * caller's retained legal-acceptance evidence before the FK cascade wipes
 * sessions, accounts, memberships, and owned content. No password and no
 * email round-trip — the typed-confirmation dialog is the intent gate.
 *
 * @returns Discriminated `TeamActionResult`; `cannot_delete_sole_owner`
 *          when an owned team must be handed off first.
 */
export async function deleteAccountAction(): Promise<TeamActionResult> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }

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
    await auth.api.deleteUser({ body: {}, headers: await headers() });
    return { ok: true };
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
