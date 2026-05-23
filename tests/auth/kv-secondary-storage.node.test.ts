import { test, expect } from "bun:test";
import { getKvSecondaryStorage } from "@/lib/db/_auth-kv-storage.node";

test("node sibling returns undefined", () => {
  expect(getKvSecondaryStorage()).toBeUndefined();
});
