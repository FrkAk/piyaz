"use server";

import { redirect } from "next/navigation";
import { createTeamAction } from "@/lib/actions/team";
import type { TeamActionResult } from "@/lib/actions/team-errors";
import {
  joinTeamByCodeAction,
  type JoinByCodeResult,
} from "@/lib/actions/team-invite-code";

/**
 * Form-friendly result from the onboarding actions. Either branch of the
 * onboarding form (create-team / join-with-code) returns this so the
 * client component can render an inline error without caring which path
 * the user took.
 */
export type OnboardResult = { ok: true } | { ok: false; message: string };

/**
 * Create a new team for the signed-in user, set it active, then redirect
 * to home. Thin wrapper around `createTeamAction` so the form stays
 * decoupled from the canonical TeamActionResult shape.
 *
 * @param input - `{ name, slug, dpaAccepted }` from the create-team form.
 * @returns `{ ok: false }` on failure (the caller redirects on success).
 */
export async function createTeam(input: {
  name: string;
  slug: string;
  dpaAccepted: boolean;
}): Promise<OnboardResult> {
  const result: TeamActionResult<{ organizationId: string }> =
    await createTeamAction(input);
  if (!result.ok) return { ok: false, message: result.message };
  redirect("/");
}

/**
 * Redeem a team invite code, then redirect to home. Replaces the old
 * UUID-paste invitation flow — see MYMR-68 / `team_invite_code` schema.
 *
 * @param input - `{ code }` from the join-with-code form.
 * @returns `{ ok: false }` on failure (the caller redirects on success).
 */
export async function acceptInviteCode(input: {
  code: string;
}): Promise<OnboardResult> {
  const result: JoinByCodeResult = await joinTeamByCodeAction(input);
  if (!result.ok) return { ok: false, message: result.message };
  redirect("/");
}
