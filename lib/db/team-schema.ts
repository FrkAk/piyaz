import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "@/lib/db/auth-schema";

/**
 * Shareable team invite codes — one row per organization in v1.
 *
 * Lives in `public` (drizzle-managed) and references `piyaz_auth.organization`
 * + `piyaz_auth.user` via cross-schema FKs. Kept separate from `lib/db/schema.ts`
 * because it's a join concept between the auth and app schemas — same split
 * we already use for `auth-schema.ts` vs `schema.ts`.
 *
 * Distinct from `piyaz_auth.invitation`: that table is per-recipient-email and
 * Better Auth's `acceptInvitation` enforces `invitation.email === session.user.email`.
 * A team-wide code can't ride that flow without forging email, so we use
 * `auth.api.addMember` against this separate table instead.
 *
 * RLS is enabled here via `.enableRLS()`; the policy DDL itself lives in
 * `docker/rls-policies.sql` (1-hop membership through `piyaz_auth.member`,
 * applied after `db:push`). The three join-path helpers in
 * `lib/data/team-invite-code.ts` (`reserveInviteCodeSlot`,
 * `releaseInviteCodeSlot`, `diagnoseTeamInviteCode`) call SECURITY DEFINER
 * SQL functions (see `docker/rls-functions.sql`) because the joining user
 * has no `piyaz_auth.member` row at the moment of lookup — the functions
 * run as their owner and have a narrow audited surface. The four admin
 * helpers (`findTeamInviteCode`, `createTeamInviteCode`,
 * `rotateTeamInviteCode`, `revokeTeamInviteCode`) run under
 * `withUserContext(adminUserId, ...)`; the action layer
 * (`lib/actions/team-invite-code.ts`) enforces admin membership of the
 * target org via {@link isOrgAdmin} before invoking them, so the admin's
 * GUC satisfies the policy USING/WITH CHECK predicates.
 */
export const teamInviteCodes = pgTable(
  "team_invite_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    defaultRole: text("default_role")
      .$type<"member" | "admin">()
      .notNull()
      .default("member"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    reservedUntil: timestamp("reserved_until", { withTimezone: true }),
    reservedBy: uuid("reserved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("team_invite_code_code_idx").on(t.code),
    check(
      "team_invite_code_default_role_check",
      sql`${t.defaultRole} IN ('member', 'admin')`,
    ),
  ],
).enableRLS();

export type TeamInviteCode = typeof teamInviteCodes.$inferSelect;
export type NewTeamInviteCode = typeof teamInviteCodes.$inferInsert;
