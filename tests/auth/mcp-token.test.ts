import { describe, expect, test } from "bun:test";
import { authContextFromPayload } from "@/lib/auth/mcp-token";

const SUB = "11111111-1111-4111-8111-111111111111";

describe("authContextFromPayload", () => {
  test("maps a verified token to an mcp actor carrying the harness clientId", () => {
    const ctx = authContextFromPayload({ sub: SUB, azp: "harness-abc" });
    expect(ctx).not.toBeNull();
    expect(ctx!.actor).toEqual({
      source: "mcp",
      userId: SUB,
      clientId: "harness-abc",
    });
  });

  test("rejects a token without azp so every mcp action records its harness", () => {
    expect(authContextFromPayload({ sub: SUB })).toBeNull();
    expect(authContextFromPayload({ sub: SUB, azp: "" })).toBeNull();
  });

  test("rejects a token without a valid sub", () => {
    expect(authContextFromPayload({ azp: "harness-abc" })).toBeNull();
    expect(authContextFromPayload({ sub: "not-a-uuid", azp: "x" })).toBeNull();
  });
});
