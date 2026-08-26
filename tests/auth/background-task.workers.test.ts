import { expect, mock, test } from "bun:test";

const enrolled: Promise<unknown>[] = [];

mock.module("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (_options?: { async?: boolean }) => ({
    ctx: {
      waitUntil: (promise: Promise<unknown>) => enrolled.push(promise),
    },
  }),
}));

const { enrollAuthBackgroundTask } = await import(
  "@/lib/auth/_background.workers"
);

test("Workers auth background tasks enroll in waitUntil", () => {
  const promise = Promise.resolve();
  enrollAuthBackgroundTask(promise);
  expect(enrolled).toEqual([promise]);
});
