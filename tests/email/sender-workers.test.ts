import { test, expect, beforeEach, afterAll, mock } from "bun:test";

/** The structured builder shape the fake `send_email` binding records. */
interface SendBuilder {
  from: string;
  to: string;
  subject: string;
  replyTo?: string;
  html: string;
  text: string;
}

const _sendCalls: SendBuilder[] = [];
let _sendImpl: (b: SendBuilder) => Promise<{ messageId: string }> =
  async () => ({
    messageId: "msg-1",
  });

const fakeEmail = {
  send(builder: SendBuilder) {
    _sendCalls.push(builder);
    return _sendImpl(builder);
  },
};

let _envHasEmail = true;
let _ctxThrows = false;

/**
 * Mock `@opennextjs/cloudflare`'s `getCloudflareContext` before the SUT
 * imports it. Pattern lifted from
 * `tests/auth/kv-secondary-storage.workers.test.ts:41-46`. `_envHasEmail`
 * flips per test to exercise the missing-binding path; `_ctxThrows`
 * simulates access outside a request context, where the real
 * `getCloudflareContext` throws.
 */
mock.module("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (_opts?: { async?: boolean }) => {
    if (_ctxThrows) throw new Error("no request context");
    return {
      env: _envHasEmail ? { EMAIL: fakeEmail } : {},
      ctx: { waitUntil: () => {} },
    };
  },
}));

const { getPlatformSender } = await import("@/lib/email/_sender.workers");

const ORIGINAL_EMAIL_FROM = process.env.EMAIL_FROM;

const message = {
  to: "user@example.com",
  from: "noreply@piyaz.ai",
  subject: "Confirm your email",
  html: "<p>hi</p>",
  text: "hi",
};

beforeEach(() => {
  _sendCalls.length = 0;
  _sendImpl = async () => ({ messageId: "msg-1" });
  _envHasEmail = true;
  _ctxThrows = false;
  process.env.EMAIL_FROM = "noreply@piyaz.ai";
});

afterAll(() => {
  if (ORIGINAL_EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = ORIGINAL_EMAIL_FROM;
});

test("returns a sender when the EMAIL binding and EMAIL_FROM are configured", () => {
  expect(getPlatformSender()).not.toBeNull();
});

test("returns null when the EMAIL binding is absent", () => {
  _envHasEmail = false;
  expect(getPlatformSender()).toBeNull();
});

test("returns null when EMAIL_FROM is unset", () => {
  delete process.env.EMAIL_FROM;
  expect(getPlatformSender()).toBeNull();
});

test("returns null when EMAIL_FROM is blank", () => {
  process.env.EMAIL_FROM = "   ";
  expect(getPlatformSender()).toBeNull();
});

test("returns null outside a Cloudflare request context", () => {
  _ctxThrows = true;
  expect(getPlatformSender()).toBeNull();
});

test("send passes the message fields to the binding verbatim", async () => {
  const sender = getPlatformSender();
  await sender?.send({ ...message, replyTo: "hello@piyaz.ai" });
  expect(_sendCalls).toEqual([
    {
      from: "noreply@piyaz.ai",
      to: "user@example.com",
      subject: "Confirm your email",
      replyTo: "hello@piyaz.ai",
      html: "<p>hi</p>",
      text: "hi",
    },
  ]);
});

test("send omits replyTo from the builder when unset", async () => {
  const sender = getPlatformSender();
  await sender?.send(message);
  expect(_sendCalls[0]).not.toContainKey("replyTo");
});

test("send does not forward category to the binding", async () => {
  const sender = getPlatformSender();
  await sender?.send({ ...message, category: "verification" });
  expect(_sendCalls[0]).not.toContainKey("category");
});

test("send maps a successful send to an ok result with the messageId", async () => {
  _sendImpl = async () => ({ messageId: "cf-abc123" });
  const result = await getPlatformSender()?.send(message);
  expect(result).toEqual({ kind: "ok", messageId: "cf-abc123" });
});

test("send maps a thrown binding error code to a typed error result", async () => {
  _sendImpl = async () => {
    const err = new Error("recipient is suppressed") as Error & {
      code: string;
    };
    err.code = "E_RECIPIENT_SUPPRESSED";
    throw err;
  };
  const result = await getPlatformSender()?.send(message);
  expect(result).toEqual({
    kind: "error",
    code: "E_RECIPIENT_SUPPRESSED",
    message: "recipient is suppressed",
  });
});

test("send maps a thrown non-Error to an E_UNKNOWN error result", async () => {
  _sendImpl = async () => {
    throw "boom";
  };
  const result = await getPlatformSender()?.send(message);
  expect(result).toEqual({ kind: "error", code: "E_UNKNOWN", message: "boom" });
});
