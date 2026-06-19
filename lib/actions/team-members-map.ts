/**
 * UI projection of a single team member. Stripped down from BA's
 * listMembers shape so the client only sees what it needs to render.
 */
export type MemberView = {
  /** Membership row id (used for role-update / remove API calls). */
  id: string;
  /** User id behind the membership — drives gradient avatar and self-row checks. */
  userId: string;
  /** Display name from `piyaz_auth.user.name`. */
  name: string;
  /** Sign-in email from `piyaz_auth.user.email`. */
  email: string;
  /** Raw `member.role` string (e.g. "owner", "admin", "member"). */
  role: string;
  /** When the user joined the team. */
  joinedAt: Date;
};

/** BA's listMembers row shape — pinned to BA 1.6.x. */
export type BetterAuthMemberRow = {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: Date | string;
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
};

/**
 * Convert a BA listMembers row into the UI view shape. Coerces
 * `createdAt` to a Date — BA may return either depending on serializer.
 *
 * @param row - Raw BA member row.
 * @returns MemberView ready for the client.
 */
export function toMemberView(row: BetterAuthMemberRow): MemberView {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    joinedAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}
