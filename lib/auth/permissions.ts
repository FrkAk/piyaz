import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

/**
 * Project-resource actions guarded by RBAC. `create`/`read`/`update` are
 * member-allowed; `delete`/`rename` require admin or owner. `rename` is
 * called out separately because it silently breaks external task refs in
 * PRs, docs, and commit messages — it deserves an explicit gate rather
 * than being folded into `delete`.
 */
const projectActions = ["create", "read", "update", "delete", "rename"] as const;
const memberProjectActions = ["create", "read", "update"] as const;

/**
 * Statement extending Better Auth's organization defaults with the
 * Mymir-specific `project` resource. Mirroring `defaultStatements` keeps
 * BA's built-in `organization`/`member`/`invitation`/`team`/`ac` policy
 * intact so team-management endpoints continue to enforce admin gating.
 */
export const statement = {
  ...defaultStatements,
  project: projectActions,
} as const;

export const ac = createAccessControl(statement);

export const owner = ac.newRole({
  ...ownerAc.statements,
  project: projectActions,
});

export const admin = ac.newRole({
  ...adminAc.statements,
  project: projectActions,
});

export const member = ac.newRole({
  ...memberAc.statements,
  project: memberProjectActions,
});

/** Lookup by BA role name. Used to evaluate comma-separated multi-role strings. */
const ROLES = { owner, admin, member } as const;

/** Action a caller can perform against the project resource. */
export type ProjectAction = (typeof projectActions)[number];

/**
 * Parse a Better Auth `member.role` value into the set of role names it
 * carries. BA 1.6.x stores roles as a comma-separated string (`"owner"`,
 * `"owner,admin"`); a future serializer change to a JSON array
 * (`'["owner","admin"]'`) is tolerated by attempting JSON parse first and
 * falling back to the comma split. Whitespace and empty fragments are
 * stripped.
 *
 * Pinned against `better-auth@1.6.x crud-members.mjs:255`. Used by both
 * the project-permission check ({@link roleHasProjectPermission}) and the
 * last-owner guard in `lib/actions/team.ts`, so a serializer change can't
 * silently flip either site open.
 *
 * @param role - Raw `member.role` string from the DB.
 * @returns Role names present on the member.
 */
export function parseMemberRoles(role: string): string[] {
  const trimmed = role.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
      }
    } catch {
      // fall through to comma split
    }
  }
  return trimmed
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Synchronous permission check against a Better Auth role string. Roles
 * are parsed via {@link parseMemberRoles}; the caller passes if any
 * sub-role holds every requested action.
 *
 * Uses `Role.authorize()` (no DB hit) so callers can chain this onto an
 * existing JOIN that already loaded `member.role`.
 *
 * @param role - Raw `member.role` value (e.g. "admin" or "admin,member").
 * @param actions - Required project actions; AND-ed (default connector).
 * @returns True when at least one parsed sub-role grants every action.
 */
export function roleHasProjectPermission(
  role: string,
  actions: readonly ProjectAction[],
): boolean {
  for (const r of parseMemberRoles(role)) {
    const def = ROLES[r as keyof typeof ROLES];
    if (!def) {
      console.warn(
        `[rbac] unknown role '${r}' in member.role; treating as no permissions. Add it to lib/auth/permissions.ts ROLES if intentional.`,
      );
      continue;
    }
    const result = def.authorize({ project: [...actions] });
    if (result.success) return true;
  }
  return false;
}
