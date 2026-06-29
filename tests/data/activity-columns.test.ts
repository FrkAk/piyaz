import { describe, expect, test } from "bun:test";
import { actorColumns } from "@/lib/data/activity";

describe("actorColumns", () => {
  test("web actor → durable keys only", () => {
    expect(actorColumns({ source: "web", userId: "u-1" })).toEqual({
      actorUserId: "u-1",
      source: "web",
      actorClientId: null,
    });
  });

  test("mcp actor carries the client id", () => {
    expect(
      actorColumns({ source: "mcp", userId: "u-1", clientId: "client-abc" }),
    ).toEqual({
      actorUserId: "u-1",
      source: "mcp",
      actorClientId: "client-abc",
    });
  });
});
