"use server";

import { z } from "zod/v4";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
import { putWaitlistEntry } from "@/lib/db/_waitlist-kv.workers";

type WaitlistFailureCode = "invalid_email" | "rate_limited" | "unknown";

export type WaitlistResult =
  | { ok: true }
  | { ok: false; code: WaitlistFailureCode; message: string };

/**
 * Rate-limit policy for `joinWaitlistAction`, on the `"auth"` backend
 * (`RATE_LIMIT_AUTH`). That binding enforces its own 5/60 per key and
 * ignores the declared max, so the policy must be exactly 5/60.
 */
const WAITLIST_RATE_LIMIT = {
  action: "waitlist.signup",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 5,
  backendKind: "auth",
} as const;

// Trim + lowercase before the email check so padded or mixed-case input
// is normalized rather than rejected; `parsed.data` is the key written to KV.
const waitlistSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});

const INVALID_EMAIL_MSG = "Enter a valid email address.";
const RATE_LIMITED_MSG =
  "Too many requests. Please slow down and try again shortly.";
const UNKNOWN_MSG = "Something went wrong. Please try again.";

/**
 * Capture an email onto the invite-only waitlist.
 *
 * Rate-limits before parsing so a malformed-input flood still costs a
 * slot. The limiter is IP-keyed (`userId` null, public form) and runs
 * before any KV write. A missing binding (self-host/dev) returns `unknown`
 * rather than throwing.
 *
 * @param input - `{ email }` from the public waitlist form.
 * @returns Discriminated result; `{ ok: true }` once the email is captured.
 */
export async function joinWaitlistAction(input: {
  email: string;
}): Promise<WaitlistResult> {
  const limit = await checkActionRateLimit(WAITLIST_RATE_LIMIT, null);
  if (!limit.ok) {
    return { ok: false, code: "rate_limited", message: RATE_LIMITED_MSG };
  }

  const parsed = waitlistSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "invalid_email", message: INVALID_EMAIL_MSG };
  }
  const email = parsed.data.email;

  const result = await putWaitlistEntry(email);
  if (result === "unavailable") {
    return { ok: false, code: "unknown", message: UNKNOWN_MSG };
  }

  return { ok: true };
}
