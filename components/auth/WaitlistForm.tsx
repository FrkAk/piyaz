"use client";

import { useState, type FormEvent } from "react";
import { joinWaitlistAction } from "@/lib/actions/waitlist";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";

/**
 * Waitlist email-capture form for the invite-only sign-up page.
 *
 * Calls the `joinWaitlistAction` server action, which rate-limits,
 * validates, and writes the email to `WAITLIST_KV`. On success the form is
 * replaced by a confirmation line rather than re-rendering empty; on
 * failure the message renders inline in the same danger-tinted strip as
 * `SignUpForm`. No third-party script (no Turnstile in v1).
 *
 * @returns Email input + submit, or the confirmation state once captured.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  /**
   * Submit the email to the waitlist action. Inline-renders the typed
   * failure message on `!ok`; flips to the confirmation state on success.
   *
   * @param event - The form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const result = await joinWaitlistAction({ email });

    if (!result.ok) {
      setError(result.message);
      setLoading(false);
      return;
    }

    setSubmitted(true);
  }

  if (submitted) {
    return (
      <p
        role="status"
        className="mb-7 rounded-md border px-3 py-2.5 text-[12.5px] text-text-secondary"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
          borderColor:
            "color-mix(in srgb, var(--color-accent) 22%, transparent)",
        }}
      >
        You&rsquo;re on the list — we&rsquo;ll email you when accounts open.
      </p>
    );
  }

  return (
    <form
      className="mb-7 flex flex-col gap-2.5"
      onSubmit={handleSubmit}
      noValidate
    >
      <AuthInput
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@company.com"
      />

      {error ? (
        <p
          role="alert"
          className="rounded-md border px-3 py-2 text-[12px] text-danger"
          style={{
            background:
              "color-mix(in srgb, var(--color-danger) 10%, transparent)",
            borderColor:
              "color-mix(in srgb, var(--color-danger) 24%, transparent)",
          }}
        >
          {error}
        </p>
      ) : null}

      <AuthSubmit isLoading={loading}>Join the waitlist</AuthSubmit>
    </form>
  );
}
