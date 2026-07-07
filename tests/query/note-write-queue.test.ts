import { describe, expect, test } from "bun:test";
import { enqueueNoteWrite } from "@/lib/query/note-cache";

/**
 * Pure unit tests for the per-note FIFO write chain. Pins the ordering,
 * isolation, and failure-continuation contracts the optimistic note
 * mutations rely on.
 */

/**
 * A job that records its start order and resolves on demand.
 * @param log - Shared order log.
 * @param name - Job name recorded at start.
 * @returns The job plus its resolve trigger.
 */
function gatedJob(log: string[], name: string) {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = async () => {
    log.push(`start:${name}`);
    await gate;
    log.push(`end:${name}`);
    return name;
  };
  return { job, release: release! };
}

describe("enqueueNoteWrite", () => {
  test("runs jobs for one note strictly in order", async () => {
    const log: string[] = [];
    const a = gatedJob(log, "a");
    const b = gatedJob(log, "b");
    const pa = enqueueNoteWrite("note-1", a.job);
    const pb = enqueueNoteWrite("note-1", b.job);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["start:a"]);
    a.release();
    await pa;
    b.release();
    await pb;
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("different notes run concurrently", async () => {
    const log: string[] = [];
    const a = gatedJob(log, "a");
    const b = gatedJob(log, "b");
    const pa = enqueueNoteWrite("note-1", a.job);
    const pb = enqueueNoteWrite("note-2", b.job);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["start:a", "start:b"]);
    a.release();
    b.release();
    await Promise.all([pa, pb]);
  });

  test("a rejected job propagates to its caller and the chain continues", async () => {
    const log: string[] = [];
    const failing = enqueueNoteWrite("note-1", async () => {
      throw new Error("boom");
    });
    const after = gatedJob(log, "after");
    const pAfter = enqueueNoteWrite("note-1", after.job);
    await expect(failing).rejects.toThrow("boom");
    after.release();
    await expect(pAfter).resolves.toBe("after");
  });

  test("returns each job's own result", async () => {
    const one = enqueueNoteWrite("note-1", async () => 1);
    const two = enqueueNoteWrite("note-1", async () => 2);
    expect(await one).toBe(1);
    expect(await two).toBe(2);
  });
});
