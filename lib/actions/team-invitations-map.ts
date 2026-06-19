/** UI projection of a single pending invitation. */
export type InvitationView = {
  /** Invitation row id — passed to cancel-invitation API. */
  id: string;
  /** Recipient email address. */
  email: string;
  /** Role granted on acceptance. Defaults to `'member'` for null BA rows. */
  role: "member" | "admin" | "owner";
  /** Status string from BA. v1 only surfaces `pending`. */
  status: string;
  /** Expiration timestamp — used to surface "expires in X" copy. */
  expiresAt: Date;
  /** When the invitation was issued. */
  createdAt: Date;
  /** Inviter display name (joined from `piyaz_auth.user.name`). */
  inviterName: string;
};

/** BA's listInvitations row shape — pinned to BA 1.6.x. */
export type BetterAuthInvitationRow = {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  inviterId: string;
  expiresAt: Date | string;
  createdAt?: Date | string;
};

/** Coerce a possibly-stringified date to a Date. */
function toDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  return new Date(value ?? Date.now());
}

/** Project a BA invitation row + resolved inviter name into a UI view. */
export function toInvitationView(
  row: BetterAuthInvitationRow,
  inviterName: string,
): InvitationView {
  const role =
    row.role === "admin" || row.role === "owner" ? row.role : "member";
  return {
    id: row.id,
    email: row.email,
    role,
    status: row.status,
    expiresAt: toDate(row.expiresAt),
    createdAt: toDate(row.createdAt),
    inviterName,
  };
}
