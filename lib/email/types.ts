/**
 * Shared contract for the email subsystem. Every transport adapter
 * (Cloudflare Workers, SMTP, Log, Fake) implements `EmailSender`, and every
 * producer (templates, brand resolver, Better Auth wiring) consumes these
 * types. This module has zero runtime imports and no side effects, so it
 * compiles identically into the Node and Workers bundles — the `server-only`
 * boundary lives in the transport adapters, not here, mirroring the
 * import-free guarantee of `lib/realtime/types.ts`.
 */

/**
 * Outcome of an `EmailSender.send()` call. Discriminated on `kind` so callers
 * must handle both arms: the `ok` arm carries the provider-returned
 * `messageId` when one is available (optional, since transports like the
 * Cloudflare `send_email` binding return no provider id); the `error` arm
 * carries a machine-readable `code` (transport specific) and a human-readable
 * `message`.
 */
export type EmailSendResult =
  | { kind: "ok"; messageId?: string }
  | { kind: "error"; code: string; message: string };

/**
 * A single transactional email to deliver. `to` is a single recipient (all
 * downstream flows are single-recipient transactional mail). Both `html` and
 * `text` are required for deliverability. `replyTo` is optional and distinct
 * from `from`. `category` is optional open metadata only — never a routing instruction;
 * purpose→address routing lives in the brand resolver, not here.
 */
export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  category?: string;
}

/**
 * Brand-level addressing and presentation defaults consumed when rendering and
 * sending mail. `appName`/`appUrl` are the always-present neutral identity; the
 * brand-presentation fields are optional so self-host renders neutral,
 * logo-less output while cloud sets them.
 */
export interface BrandConfig {
  appName: string;
  appUrl: string;
  logoUrl?: string;
  brandColor?: string;
  footerLinks?: { label: string; url: string }[];
  supportEmail?: string;
}

/**
 * The transport contract. A single `send()` method keeps adapters tiny;
 * templating and addressing live above the transport.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
