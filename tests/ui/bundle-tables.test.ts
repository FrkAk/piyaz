import { expect, test } from "bun:test";
import {
  BUNDLE_BY_STAGE,
  BUNDLE_LABEL_BY_STAGE,
  resolveStage,
  variantOf,
} from "@/components/workspace/bundle-tables";

test("blocked state splits on schema status: draft stays working, planned goes agent", () => {
  expect(resolveStage("draft", "blocked")).toBe("draft");
  expect(resolveStage("planned", "blocked")).toBe("planned-blocked");
  expect(BUNDLE_BY_STAGE[resolveStage("draft", "blocked")]).toBe("working");
  expect(BUNDLE_BY_STAGE[resolveStage("planned", "blocked")]).toBe("agent");
});

test("non-blocked states map through directly", () => {
  expect(resolveStage("draft", "draft")).toBe("draft");
  expect(resolveStage("draft", "plannable")).toBe("plannable");
  expect(resolveStage("planned", "ready")).toBe("ready");
  expect(resolveStage("in_progress", "in_progress")).toBe("in_progress");
  expect(resolveStage("in_review", "in_review")).toBe("in_review");
  expect(resolveStage("done", "done")).toBe("done");
  expect(resolveStage("cancelled", "cancelled")).toBe("cancelled");
});

test("missing derived state falls back to schema status", () => {
  expect(resolveStage("draft", undefined)).toBe("draft");
  expect(resolveStage("planned", undefined)).toBe("ready");
  expect(resolveStage("done", undefined)).toBe("done");
});

test("record kind splits into done and cancelled variants with distinct labels", () => {
  expect(variantOf("done")).toBe("record-done");
  expect(variantOf("cancelled")).toBe("record-cancelled");
  expect(variantOf("ready")).toBe("agent");
  expect(BUNDLE_LABEL_BY_STAGE.done).toBe("completion record");
  expect(BUNDLE_LABEL_BY_STAGE.cancelled).toBe("cancellation record");
});
