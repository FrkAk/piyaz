import { describe, expect, test } from "bun:test";
import { mapBetterAuthError } from "@/lib/actions/team-errors";

/**
 * Pure unit tests for `mapBetterAuthError`. No DB. Pins the BA error-code
 * → `TeamActionFailureCode` mapping so a Better Auth upgrade adding or
 * renaming a code surfaces here, not in production. Covers every key from
 * the switch in `lib/actions/team-errors.ts:107-138`, the
 * `FORBIDDEN_CODES` allowlist, the `YOU_ARE_NOT_ALLOWED_TO_*`
 * heuristic fallback, the `unknown` fallback for non-Error inputs, and a
 * non-string `code` field.
 */

function baError(code: string): unknown {
  return { body: { code } };
}

describe("mapBetterAuthError — switch-case branches", () => {
  test("USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION → already_member", () => {
    expect(
      mapBetterAuthError(
        baError("USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"),
      ),
    ).toBe("already_member");
  });

  test("USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION → already_invited", () => {
    expect(
      mapBetterAuthError(
        baError("USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION"),
      ),
    ).toBe("already_invited");
  });

  test("INVITATION_NOT_FOUND → not_found", () => {
    expect(mapBetterAuthError(baError("INVITATION_NOT_FOUND"))).toBe(
      "not_found",
    );
  });

  test("MEMBER_NOT_FOUND → not_found", () => {
    expect(mapBetterAuthError(baError("MEMBER_NOT_FOUND"))).toBe("not_found");
  });

  test("ORGANIZATION_NOT_FOUND → not_found", () => {
    expect(mapBetterAuthError(baError("ORGANIZATION_NOT_FOUND"))).toBe(
      "not_found",
    );
  });

  test("USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION → not_found", () => {
    expect(
      mapBetterAuthError(baError("USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION")),
    ).toBe("not_found");
  });

  test("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION → wrong_recipient", () => {
    expect(
      mapBetterAuthError(
        baError("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION"),
      ),
    ).toBe("wrong_recipient");
  });

  test("EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION → email_verification_required", () => {
    expect(
      mapBetterAuthError(
        baError(
          "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
        ),
      ),
    ).toBe("email_verification_required");
  });

  test("ORGANIZATION_MEMBERSHIP_LIMIT_REACHED → membership_limit_reached", () => {
    expect(
      mapBetterAuthError(baError("ORGANIZATION_MEMBERSHIP_LIMIT_REACHED")),
    ).toBe("membership_limit_reached");
  });

  test("INVITATION_LIMIT_REACHED → membership_limit_reached", () => {
    expect(mapBetterAuthError(baError("INVITATION_LIMIT_REACHED"))).toBe(
      "membership_limit_reached",
    );
  });

  test("YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER → cannot_leave_only_owner", () => {
    expect(
      mapBetterAuthError(
        baError("YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER"),
      ),
    ).toBe("cannot_leave_only_owner");
  });

  test("YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER → cannot_leave_only_owner", () => {
    expect(
      mapBetterAuthError(
        baError("YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER"),
      ),
    ).toBe("cannot_leave_only_owner");
  });

  test("ORGANIZATION_ALREADY_EXISTS → slug_taken", () => {
    expect(mapBetterAuthError(baError("ORGANIZATION_ALREADY_EXISTS"))).toBe(
      "slug_taken",
    );
  });

  test("ORGANIZATION_SLUG_ALREADY_TAKEN → slug_taken", () => {
    expect(mapBetterAuthError(baError("ORGANIZATION_SLUG_ALREADY_TAKEN"))).toBe(
      "slug_taken",
    );
  });

  test("INVALID_PASSWORD → invalid_password", () => {
    expect(mapBetterAuthError(baError("INVALID_PASSWORD"))).toBe(
      "invalid_password",
    );
  });

  test("PASSWORD_TOO_SHORT → invalid_input", () => {
    expect(mapBetterAuthError(baError("PASSWORD_TOO_SHORT"))).toBe(
      "invalid_input",
    );
  });

  test("PASSWORD_TOO_LONG → invalid_input", () => {
    expect(mapBetterAuthError(baError("PASSWORD_TOO_LONG"))).toBe(
      "invalid_input",
    );
  });
});

describe("mapBetterAuthError — FORBIDDEN_CODES allowlist", () => {
  const FORBIDDEN_CODES = [
    "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM",
    "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER",
    "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION",
    "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE",
    "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER",
    "YOU_ARE_NOT_ALLOWED_TO_CREATE_TEAMS_IN_THIS_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_DELETE_TEAMS_IN_THIS_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_TEAM",
    "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_TEAM",
    "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM_MEMBER",
    "YOU_ARE_NOT_ALLOWED_TO_REMOVE_A_TEAM_MEMBER",
    "YOU_ARE_NOT_ALLOWED_TO_ACCESS_THIS_ORGANIZATION",
    "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_ROLE",
    "YOU_ARE_NOT_ALLOWED_TO_UPDATE_A_ROLE",
    "YOU_ARE_NOT_ALLOWED_TO_DELETE_A_ROLE",
    "YOU_ARE_NOT_ALLOWED_TO_READ_A_ROLE",
    "YOU_ARE_NOT_ALLOWED_TO_LIST_A_ROLE",
    "YOU_ARE_NOT_ALLOWED_TO_GET_A_ROLE",
  ];

  for (const code of FORBIDDEN_CODES) {
    test(`${code} → forbidden`, () => {
      expect(mapBetterAuthError(baError(code))).toBe("forbidden");
    });
  }
});

describe("mapBetterAuthError — heuristic fallback for unknown authz codes", () => {
  test("YOU_ARE_NOT_ALLOWED_TO_FROBNICATE → forbidden (heuristic)", () => {
    expect(
      mapBetterAuthError(baError("YOU_ARE_NOT_ALLOWED_TO_FROBNICATE")),
    ).toBe("forbidden");
  });

  test("totally novel YOU_ARE_NOT_ALLOWED_TO_* code falls through to forbidden", () => {
    expect(
      mapBetterAuthError(baError("YOU_ARE_NOT_ALLOWED_TO_DO_THINGS_OF_KIND_X")),
    ).toBe("forbidden");
  });
});

describe("mapBetterAuthError — unknown fallbacks", () => {
  test("non-Error input (plain string) → unknown", () => {
    expect(mapBetterAuthError("something broke")).toBe("unknown");
  });

  test("null → unknown", () => {
    expect(mapBetterAuthError(null)).toBe("unknown");
  });

  test("undefined → unknown", () => {
    expect(mapBetterAuthError(undefined)).toBe("unknown");
  });

  test("error with no body → unknown", () => {
    expect(mapBetterAuthError(new Error("plain"))).toBe("unknown");
  });

  test("error with body.code as a non-string number → unknown", () => {
    expect(mapBetterAuthError({ body: { code: 42 } })).toBe("unknown");
  });

  test("error with body.code as an object → unknown", () => {
    expect(mapBetterAuthError({ body: { code: { nested: true } } })).toBe(
      "unknown",
    );
  });

  test("totally unrecognized string code → unknown", () => {
    expect(mapBetterAuthError(baError("SOME_FUTURE_NEW_CODE"))).toBe("unknown");
  });
});
