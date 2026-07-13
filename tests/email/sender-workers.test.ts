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
 * `getCloudflareContext` throws. The module mock is process-global and
 * unrestoreable, so `afterAll` parks `_ctxThrows = true` to match that
 * out-of-Workers throw for any later test file importing the indirection.
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

const { getPlatformSender, __resetMissingBindingWarnedForTest } = await import(
  "@/lib/email/_sender.workers"
);

/** Every var the capability gate reads, so each test starts from a clean slate. */
const SENDER_VARS = [
  "EMAIL_FROM",
  "EMAIL_FROM_NOREPLY",
  "EMAIL_FROM_SUPPORT",
  "EMAIL_FROM_INFO",
] as const;

const ORIGINAL_SENDER_VARS = SENDER_VARS.map(
  (name) => [name, process.env[name]] as const,
);

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
  for (const name of SENDER_VARS) delete process.env[name];
  process.env.EMAIL_FROM = "noreply@piyaz.ai";
  __resetMissingBindingWarnedForTest();
});

afterAll(() => {
  _ctxThrows = true;
  for (const [name, value] of ORIGINAL_SENDER_VARS) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("returns a sender when the EMAIL binding and EMAIL_FROM are configured", () => {
  expect(getPlatformSender()).not.toBeNull();
});

test("returns a sender when only the per-purpose address vars are configured", () => {
  delete process.env.EMAIL_FROM;
  process.env.EMAIL_FROM_NOREPLY = "noreply@example.com";
  process.env.EMAIL_FROM_SUPPORT = "hello@example.com";
  expect(getPlatformSender()).not.toBeNull();
});

test("returns null when the EMAIL binding is absent", () => {
  _envHasEmail = false;
  expect(getPlatformSender()).toBeNull();
});

test("returns null when no sender address is configured", () => {
  delete process.env.EMAIL_FROM;
  expect(getPlatformSender()).toBeNull();
});

test("returns null when every sender address is blank", () => {
  process.env.EMAIL_FROM = "   ";
  process.env.EMAIL_FROM_NOREPLY = "";
  expect(getPlatformSender()).toBeNull();
});

test("returns null outside a Cloudflare request context", () => {
  _ctxThrows = true;
  expect(getPlatformSender()).toBeNull();
});

test("warns once per isolate when the EMAIL binding is missing", () => {
  _envHasEmail = false;
  const warn = mock((_line: string) => {});
  const original = console.warn;
  console.warn = warn;
  try {
    getPlatformSender();
    getPlatformSender();
  } finally {
    console.warn = original;
  }
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(warn.mock.calls[0]![0])).toMatchObject({
    event: "email_binding_unavailable",
  });
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

test("send maps a thrown null to an E_UNKNOWN error result rather than throwing", async () => {
  _sendImpl = async () => {
    throw null;
  };
  const result = await getPlatformSender()?.send(message);
  expect(result).toEqual({ kind: "error", code: "E_UNKNOWN", message: "null" });
});
