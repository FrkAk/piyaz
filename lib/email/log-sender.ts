import type { OutboundEmail, EmailDeliveryResult, EmailSender } from "./types";

const LOG_PREFIX = "[email:log]";

/**
 * Zero-config default `EmailSender` for local dev and unconfigured self-host.
 * Renders the message to the server console instead of sending. No runtime
 * imports and no side effects.
 */
export class LogSender implements EmailSender {
  async send(message: OutboundEmail): Promise<EmailDeliveryResult> {
    const urls = (message.text.match(/https?:\/\/\S+/g) ?? []).map((u) =>
      u.replace(/[.,;:!?)\]>'"]+$/, ""),
    );
    const messageId = `log-${crypto.randomUUID()}`;

    console.info(
      `${LOG_PREFIX} email (not sent)\n` +
        `  to:       ${message.to}\n` +
        `  from:     ${message.from}\n` +
        `  replyTo:  ${message.replyTo ?? "(none)"}\n` +
        `  subject:  ${message.subject}\n` +
        `  id:       ${messageId}\n` +
        `  URLs:     ${urls.length ? "" : "(none found)"}\n` +
        urls.map((u) => `    - ${u}`).join("\n") +
        (urls.length ? "\n" : "") +
        `  text:\n${message.text}`,
    );

    return { kind: "ok", messageId };
  }
}
