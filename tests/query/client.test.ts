import { expect, test } from "bun:test";
import { makeQueryClient } from "@/lib/query/client";

test("makeQueryClient disables focus-driven refetches", () => {
  const qc = makeQueryClient();

  expect(qc.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
});
