import { test, expect } from "bun:test";
import {
  accessLevel,
  applyAccessLevel,
  feedTargetActive,
} from "@/components/workspace/notes/settings-access";

test("accessLevel derives from write flags, locked winning", () => {
  expect(accessLevel({ agentWritable: true, locked: false })).toBe("open");
  expect(accessLevel({ agentWritable: false, locked: false })).toBe("agent");
  expect(accessLevel({ agentWritable: false, locked: true })).toBe("locked");
  expect(accessLevel({ agentWritable: true, locked: true })).toBe("locked");
});

test("applyAccessLevel maps each level back to its write flags", () => {
  expect(applyAccessLevel("open")).toEqual({
    agentWritable: true,
    locked: false,
  });
  expect(applyAccessLevel("agent")).toEqual({
    agentWritable: false,
    locked: false,
  });
  expect(applyAccessLevel("locked")).toEqual({
    agentWritable: false,
    locked: true,
  });
});

test("accessLevel and applyAccessLevel round-trip", () => {
  for (const level of ["open", "agent", "locked"] as const) {
    expect(accessLevel(applyAccessLevel(level))).toBe(level);
  }
});

test("feedTargetActive matches display-case options against lowercase storage", () => {
  expect(feedTargetActive(["backend"], "Backend")).toBe(true);
  expect(feedTargetActive(["backend", "mcp"], "MCP")).toBe(true);
  expect(feedTargetActive(["backend"], "Frontend")).toBe(false);
  expect(feedTargetActive([], "Backend")).toBe(false);
});
