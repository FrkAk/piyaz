"use server";

import { headers } from "next/headers";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { requireLegalConsent } from "@/lib/auth/consent";
import { getAuthContext } from "@/lib/auth/context";
import { requireTeamMembership } from "@/lib/auth/membership";
import { ForbiddenError } from "@/lib/auth/authorization";
import {
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from "@/lib/actions/team-errors";
import {
  toMemberView,
  type BetterAuthMemberRow,
  type MemberView,
} from "@/lib/actions/team-members-map";

const inputSchema = z.object({
  organizationId: z.uuid(),
});

/** Maximum members loaded in a single page. v1 cap; pagination later. */
const PAGE_LIMIT = 200;

/**
 * List members of a team the caller belongs to. Wraps `auth.api.listMembers`
 * for BA-canonical pagination/filter semantics, but adds an explicit
 * `requireTeamMembership` JOIN first so non-members get a 404-shaped
 * `forbidden` (anti-enumeration) instead of leaking through BA's own gate.
 *
 * @param input - `{ organizationId }` of the target team.
 * @returns Discriminated result; `data` is the ordered member list.
 */
export async function listTeamMembersAction(input: {
  organizationId: string;
}): Promise<TeamActionResult<MemberView[]>> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return teamFail("unauthorized");
  }
  await requireLegalConsent(ctx.userId);

  const parsed = parseOrFail(inputSchema, input);
  if (!parsed.ok) return parsed;

  try {
    await requireTeamMembership(parsed.data.organizationId, ctx);
  } catch (err) {
    if (err instanceof ForbiddenError) return teamFail("forbidden");
    throw err;
  }

  try {
    const result = await auth.api.listMembers({
      query: { organizationId: parsed.data.organizationId, limit: PAGE_LIMIT },
      headers: await headers(),
    });
    const rows = (result?.members ?? []) as BetterAuthMemberRow[];
    return { ok: true, data: rows.map(toMemberView) };
  } catch (err) {
    console.error("listTeamMembersAction failed", err);
    return teamFail("unknown");
  }
}
