import type {
  EmailDeliveryResult,
  EmailSender,
  OutboundEmail,
} from "@/lib/email/types";

/**
 * Capturing `EmailSender` test double. Records every message at `send()`
 * invocation; `nextResult` flips the returned arm to exercise delivery-failure
 * logging.
 *
 * Captures are NOT visible in the same tick as the call that triggers them:
 * `deliverAuthEmail` awaits the per-recipient budget check
 * (`lib/email/budget.ts`) before dispatching, so a floated send lands a few
 * microtasks later. Await {@link settle} before reading {@link sent}.
 */
export class FakeEmailSender implements EmailSender {
  /** Messages in dispatch order. */
  readonly sent: OutboundEmail[] = [];

  /** Result the next `send()` resolves with. */
  nextResult: EmailDeliveryResult = { kind: "ok", messageId: "fake-1" };

  /**
   * Record the message and resolve with `nextResult`.
   *
   * @param message - The outbound email under test.
   * @returns The configured delivery result.
   */
  async send(message: OutboundEmail): Promise<EmailDeliveryResult> {
    this.sent.push(message);
    return this.nextResult;
  }
}

/**
 * Yield long enough for any floated auth-email send to reach the transport.
 *
 * `deliverAuthEmail` never awaits its send, and the budget gate in front of it
 * adds a short async prefix, so a send dispatched during an awaited request is
 * still in flight when that request resolves. A macrotask boundary drains both.
 *
 * @returns Resolves once pending floated sends have hit the fake.
 */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
