import { test, expect } from "bun:test";
import {
  shouldAdoptServerTitle,
  shouldClearDirty,
  shouldCommitTitle,
} from "@/components/workspace/notes/title-reconcile";

/**
 * Pure unit tests for the note editor title reconciliation predicates. No
 * DOM, no cache. Pins the adopt/commit outcomes the editor's render-phase
 * reconcile and blur/Enter/unmount commit dispatch on, guarding against the
 * stale-title clobber (PYZ-301) and the never-overwrite-in-progress-edit
 * invariant (AC 4b46ea3f).
 */

test("shouldAdoptServerTitle adopts only when idle", () => {
  expect(shouldAdoptServerTitle({ dirty: false, focused: false })).toBe(true);
  expect(shouldAdoptServerTitle({ dirty: true, focused: false })).toBe(false);
  expect(shouldAdoptServerTitle({ dirty: false, focused: true })).toBe(false);
  expect(shouldAdoptServerTitle({ dirty: true, focused: true })).toBe(false);
});

test("shouldCommitTitle commits only a dirty, diverged, unlocked, seeded edit", () => {
  expect(
    shouldCommitTitle({
      dirty: true,
      localTitle: "new",
      serverTitle: "old",
      locked: false,
    }),
  ).toBe(true);
});

test("shouldCommitTitle skips a clean divergence (external rename)", () => {
  expect(
    shouldCommitTitle({
      dirty: false,
      localTitle: "stale",
      serverTitle: "renamed",
      locked: false,
    }),
  ).toBe(false);
});

test("shouldCommitTitle skips a locked note", () => {
  expect(
    shouldCommitTitle({
      dirty: true,
      localTitle: "new",
      serverTitle: "old",
      locked: true,
    }),
  ).toBe(false);
});

test("shouldCommitTitle skips an unchanged title", () => {
  expect(
    shouldCommitTitle({
      dirty: true,
      localTitle: "same",
      serverTitle: "same",
      locked: false,
    }),
  ).toBe(false);
});

test("shouldCommitTitle skips a null local title", () => {
  expect(
    shouldCommitTitle({
      dirty: true,
      localTitle: null,
      serverTitle: "old",
      locked: false,
    }),
  ).toBe(false);
});

test("shouldClearDirty clears a dirty edit that reverted to the server value", () => {
  expect(
    shouldClearDirty({ dirty: true, localTitle: "same", serverTitle: "same" }),
  ).toBe(true);
});

test("shouldClearDirty leaves a dirty diverged edit alone", () => {
  expect(
    shouldClearDirty({ dirty: true, localTitle: "new", serverTitle: "old" }),
  ).toBe(false);
});

test("shouldClearDirty is a no-op when not dirty or unseeded", () => {
  expect(
    shouldClearDirty({ dirty: false, localTitle: "same", serverTitle: "same" }),
  ).toBe(false);
  expect(
    shouldClearDirty({ dirty: true, localTitle: null, serverTitle: "old" }),
  ).toBe(false);
});
