import { test, expect, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { FakeEmailSender, settle } from "@/tests/setup/fake-email";
import type { EmailSender } from "@/lib/email/types";

/**
 * Delivery-failure containment for the floated auth-email sends
 * (`deliverAuthEmail` in `lib/auth/emails.ts`). Both failure arms — a
 * resolved `{ kind: "error" }` delivery result and a rejected `send()` —
 * must log one structured `auth_email_send_failed` event without the
 * recipient address and never throw into the completed auth flow.
 */

let _platformSender: EmailSender | null = null;

// Behavior-preserving defaults (null/false match the real node stub), so the
// process-global, unrestoreable mock is inert for any later test file.
mock.module("@/lib/email/_sender", () => ({
  getPlatformSender: () => _platformSender,
  platformEmailConfigured: () => _platformSender !== null,
}));

const { sendPasswordChangedEmail } = await import("@/lib/auth/emails");
const { EMAIL_BUDGET } = await import("@/lib/email/budget");

const RECIPIENT = "delivery-fail@test.local";
const ORIGINAL_EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT;

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  delete process.env.EMAIL_TRANSPORT;
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  _platformSender = null;
  if (ORIGINAL_EMAIL_TRANSPORT === undefined)
    delete process.env.EMAIL_TRANSPORT;
  else process.env.EMAIL_TRANSPORT = ORIGINAL_EMAIL_TRANSPORT;
});

/**
 * Parse the single structured failure event captured by the console spy.
 *
 * @returns The parsed log event and the raw logged string.
 */
function capturedFailureEvent(): {
  event: Record<string, unknown>;
  raw: string;
} {
  expect(errorSpy).toHaveBeenCalledTimes(1);
  const raw = errorSpy.mock.calls[0]?.[0] as string;
  return { event: JSON.parse(raw) as Record<string, unknown>, raw };
}

test("an error delivery result logs the structured event without the recipient and does not throw", async () => {
  const fake = new FakeEmailSender();
  fake.nextResult = { kind: "error", code: "rejected", message: "boom" };
  _platformSender = fake;

  sendPasswordChangedEmail({ email: RECIPIENT, name: "Fail Case" }, {});
  await settle();

  expect(fake.sent.length).toBe(1);
  const { event, raw } = capturedFailureEvent();
  expect(event.event).toBe("auth_email_send_failed");
  expect(event.template).toBe("passwordChanged");
  expect(event.code).toBe("rejected");
  expect(event.message).toBe("boom");
  expect(raw).not.toContain(RECIPIENT);
});

test("a rejected send logs the structured event without the recipient and does not throw", async () => {
  _platformSender = {
    send: async () => {
      throw new Error("network down");
    },
  };

  sendPasswordChangedEmail({ email: RECIPIENT, name: "Fail Case" }, {});
  await settle();

  const { event, raw } = capturedFailureEvent();
  expect(event.event).toBe("auth_email_send_failed");
  expect(event.template).toBe("passwordChanged");
  expect(event.message).toBe("network down");
  expect(raw).not.toContain(RECIPIENT);
});

test("an over-budget recipient stops reaching the transport", async () => {
  // The per-recipient cap is the mail-bomb defence: past the budget the send
  // must be dropped before the transport, not merely retried or logged after
  // delivery. Uses its own address so the shared counter starts clean.
  const fake = new FakeEmailSender();
  _platformSender = fake;
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (let i = 0; i < EMAIL_BUDGET.defaultMax + 2; i++) {
      sendPasswordChangedEmail(
        { email: "flooded@test.local", name: "Flooded" },
        {},
      );
      await settle();
    }
    expect(fake.sent.length).toBe(EMAIL_BUDGET.defaultMax);
    const events = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("auth_email_budget_exceeded"));
    expect(events.length).toBe(2);
    // The structured event must not carry the recipient address.
    expect(events.join("\n")).not.toContain("flooded@test.local");
  } finally {
    warnSpy.mockRestore();
  }
});

test("a provider failure does not spend the recipient's allowance", async () => {
  // The budget counts delivered mail, not attempts. Counting at the check
  // instead would let a transient Cloudflare Email Sending outage burn a real
  // user's hourly cap and leave them unable to receive the mail at all once
  // the provider recovered.
  const fake = new FakeEmailSender();
  fake.nextResult = { kind: "error", code: "boom", message: "provider down" };
  _platformSender = fake;

  for (let i = 0; i < EMAIL_BUDGET.defaultMax + 3; i++) {
    sendPasswordChangedEmail(
      { email: "outage@test.local", name: "Outage" },
      {},
    );
    await settle();
  }
  expect(fake.sent.length).toBe(EMAIL_BUDGET.defaultMax + 3);

  // The provider recovers; the recipient still has their full allowance.
  fake.nextResult = { kind: "ok", messageId: "recovered" };
  const before = fake.sent.length;
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    sendPasswordChangedEmail(
      { email: "outage@test.local", name: "Outage" },
      {},
    );
    await settle();
  }
  expect(fake.sent.length).toBe(before + EMAIL_BUDGET.defaultMax);
});
