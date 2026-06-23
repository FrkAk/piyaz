"use client";

import { useState, type FormEvent } from "react";
import { joinWaitlistAction } from "@/lib/actions/waitlist";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";

/**
 * Waitlist email-capture form for the invite-only sign-up page.
 *
 * Submits to `joinWaitlistAction`, which rate-limits, validates, and
 * writes to `WAITLIST_KV`. Renders a confirmation line on success and an
 * inline error on failure.
 *
 * @returns Email input + submit, or the confirmation state once captured.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  /**
   * Submit the email to the waitlist action. Renders the failure message
   * inline on `!ok`; flips to the confirmation state on success.
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
        You&rsquo;re on the list. We&rsquo;ll email you when accounts open.
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
