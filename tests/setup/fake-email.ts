import type {
  EmailDeliveryResult,
  EmailSender,
  OutboundEmail,
} from "@/lib/email/types";

/**
 * Capturing `EmailSender` test double. Records every message synchronously
 * at `send()` invocation, so captures are visible the moment the code under
 * test dispatches a floated send — no timers or flushing. `nextResult` flips
 * the returned arm to exercise delivery-failure logging.
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
