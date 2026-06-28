import { describe, expect, test } from "bun:test";
import { makeAuthContext } from "@/lib/auth/context";

describe("makeAuthContext actor", () => {
  test("defaults to a system actor when none supplied", () => {
    const ctx = makeAuthContext("u-1");
    expect(ctx.userId).toBe("u-1");
    expect(ctx.actor).toEqual({ source: "system", userId: "u-1" });
  });

  test("carries an explicit mcp actor", () => {
    const ctx = makeAuthContext("u-1", {
      source: "mcp",
      userId: "u-1",
      clientId: "client-abc",
    });
    expect(ctx.actor).toEqual({
      source: "mcp",
      userId: "u-1",
      clientId: "client-abc",
    });
  });
});
