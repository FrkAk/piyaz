import { describe, expect, test } from "bun:test";
import { safeInviteNext } from "@/lib/auth/invite-next";

/**
 * Table coverage for the `next` return-destination allowlist. The helper
 * is the only thing standing between the invite CTAs / middleware bounce
 * and an open redirect, so every rejection class is pinned: absolute
 * URLs, protocol-relative, traversal, nested segments, queries,
 * fragments, wrong case, whitespace, and over-length ids.
 */

describe("safeInviteNext", () => {
  test("accepts exactly an invitation detail path", () => {
    expect(safeInviteNext("/invitations/abc")).toBe("/invitations/abc");
    expect(safeInviteNext("/invitations/aB0-_z")).toBe("/invitations/aB0-_z");
    expect(
      safeInviteNext("/invitations/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"),
    ).toBe("/invitations/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    const max = `/invitations/${"a".repeat(64)}`;
    expect(safeInviteNext(max)).toBe(max);
  });

  test("rejects everything that is not an invitation detail path", () => {
    const rejected = [
      null,
      undefined,
      "",
      "/",
      "/invitations",
      "/invitations/",
      "/invitations/a/b",
      "/invitations/../settings",
      "/invitations/a?x=1",
      "/invitations/a#frag",
      "/invitations/a b",
      "//evil.example/invitations/a",
      "https://evil.example/invitations/a",
      "javascript:alert(1)",
      "/INVITATIONS/a",
      " /invitations/a",
      `/invitations/${"a".repeat(65)}`,
    ];
    for (const raw of rejected) {
      expect(safeInviteNext(raw)).toBeNull();
    }
  });
});
