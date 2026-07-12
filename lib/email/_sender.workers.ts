import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { hasConfiguredSender } from "./brand";
import type { EmailDeliveryResult, EmailSender, OutboundEmail } from "./types";

/**
 * Structured surface of the Cloudflare Email Sending `send_email` binding.
 * File-local stub because `@cloudflare/workers-types` is banned by the
 * `no-restricted-imports` ESLint rule; mirrors the generated `SendEmail`
 * builder overload in `cloudflare-env.d.ts`.
 */
interface SendEmailBinding {
  send(builder: {
    from: string;
    to: string;
    subject: string;
    replyTo?: string;
    html: string;
    text: string;
  }): Promise<{ messageId: string }>;
}

/** The `WorkerEnv` subset this transport reads: only the `EMAIL` binding. */
interface WorkerEnv {
  EMAIL?: SendEmailBinding;
}

/**
 * Per-isolate dedupe flag for the missing-binding warning. Resets when an
 * isolate cold-starts, so misconfigurations log once per isolate boot.
 * Mirrors `lib/db/_auth-kv-storage.workers.ts`.
 */
let _missingBindingWarned = false;

/**
 * Test-only: reset the warn-once flag so a test exercising the missing-
 * binding path can assert independently on the structured warn output.
 * Not part of the runtime contract; never call from production code.
 */
export function __resetMissingBindingWarnedForTest(): void {
  _missingBindingWarned = false;
}

/**
 * Resolve the `EMAIL` binding per call; module-load access to
 * `getCloudflareContext` throws because there is no request context at boot.
 * Returns `null` when the binding is absent (self-host, misconfigured env),
 * warning once per isolate so a dropped binding is visible in Workers logs
 * rather than silently disabling every email surface.
 */
function getEmailBinding(): SendEmailBinding | null {
  try {
    const env = getCloudflareContext({ async: false }).env as WorkerEnv;
    if (env.EMAIL) return env.EMAIL;
  } catch {
    // No active CF request context — fall through to the warning.
  }
  if (!_missingBindingWarned) {
    _missingBindingWarned = true;
    console.warn(
      JSON.stringify({
        event: "email_binding_unavailable",
        hint: "EMAIL binding missing or called outside a request context; email is disabled.",
      }),
    );
  }
  return null;
}

/**
 * Map a value thrown by the binding to the typed error arm. Binding failures
 * are `Error`s carrying a string `code` (`E_SENDER_NOT_VERIFIED`,
 * `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_VALIDATION_ERROR`,
 * `E_RECIPIENT_SUPPRESSED`, ...); anything else maps to `E_UNKNOWN`.
 */
function toDeliveryError(err: unknown): EmailDeliveryResult {
  const raw =
    typeof err === "object" && err !== null
      ? (err as { code?: unknown }).code
      : undefined;
  const code = typeof raw === "string" ? raw : "E_UNKNOWN";
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "error", code, message };
}

/**
 * `EmailSender` backed by the Cloudflare Email Sending `send_email` binding's
 * structured object API. Never throws: binding errors surface as the typed
 * `error` arm of `EmailDeliveryResult`.
 */
class CloudflareEmailSender implements EmailSender {
  constructor(private readonly binding: SendEmailBinding) {}

  async send(message: OutboundEmail): Promise<EmailDeliveryResult> {
    try {
      const { messageId } = await this.binding.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo !== undefined && { replyTo: message.replyTo }),
      });
      return { kind: "ok", messageId };
    } catch (err) {
      return toDeliveryError(err);
    }
  }
}

/**
 * Cloudflare Workers platform transport selection.
 *
 * The webpack alias in `next.config.ts` resolves `lib/email/_sender` to this
 * sibling on `DEPLOY_TARGET=cloudflare` builds.
 *
 * Resolved per call (the `EMAIL` binding is request-scoped): returns the
 * binding-backed sender when the `EMAIL` binding is bound and the deployment
 * configured a sender address (see `hasConfiguredSender`), so the gate accepts
 * every address configuration `senderFor` supports.
 *
 * @returns The configured sender, or `null` when no transport is available.
 */
export function getPlatformSender(): EmailSender | null {
  const binding = getEmailBinding();
  if (binding === null || !hasConfiguredSender()) return null;
  return new CloudflareEmailSender(binding);
}
