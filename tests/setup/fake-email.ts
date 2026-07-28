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
 * adds an async prefix, so a send dispatched during an awaited request is still
 * in flight when that request resolves.
 *
 * One macrotask is sufficient only because that whole chain is microtask-only:
 * Bun resolves `crypto.subtle.digest` synchronously into the microtask queue,
 * the node budget store is an in-memory map, and this fake pushes
 * synchronously, so the microtask queue drains completely before a
 * `setTimeout(0)` callback runs. That precondition is load-bearing and not
 * portable: under Node the same digest goes to the libuv threadpool and lands
 * *after* the timer. Introduce real I/O anywhere in the chain (a KV-backed
 * budget store under a Workers-target run, a network call) and this stops
 * being enough; the symptom is an intermittent empty `sent`.
 *
 * @returns Resolves once pending floated sends have hit the fake.
 */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
