import { expect, test } from "bun:test";
import { createInputSchema } from "@/lib/mcp/schemas";

/**
 * Build a minimal valid create payload with one overridable task item.
 *
 * @param item - Task-item field overrides.
 * @returns A payload for `createInputSchema.safeParse`.
 */
function payload(item: Record<string, unknown>): Record<string, unknown> {
  return {
    project: "PYZ",
    tasks: [{ title: "Do the thing", description: "Does it. Fully.", ...item }],
  };
}

test("create schema rejects empty title and description", () => {
  expect(createInputSchema.safeParse(payload({ title: "" })).success).toBe(
    false,
  );
  expect(
    createInputSchema.safeParse(payload({ description: "" })).success,
  ).toBe(false);
  expect(createInputSchema.safeParse(payload({})).success).toBe(true);
});

test("create schema constrains assigneeIds to 'me' or a UUID", () => {
  expect(
    createInputSchema.safeParse(payload({ assigneeIds: ["not-a-uuid"] }))
      .success,
  ).toBe(false);
  expect(
    createInputSchema.safeParse(
      payload({
        assigneeIds: ["me", "5e0c9878-2ff3-4f88-b6b7-570c1a5f24b0"],
      }),
    ).success,
  ).toBe(true);
});
