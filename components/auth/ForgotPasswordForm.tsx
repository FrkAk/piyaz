"use client";

import { useState, type FormEvent } from "react";
import { requestPasswordReset } from "@/lib/auth-client";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";

/**
 * Password-reset request form for `/forgot-password`.
 *
 * Every non-rate-limited submit flips to the neutral "if an account
 * exists" strip — the endpoint 200s for unknown addresses
 * (anti-enumeration), so the UI never branches on existence. Better Auth
 * emails a link through `/api/auth/reset-password/<token>` which
 * redirects to `/reset-password?token=…` per the `redirectTo` sent here.
 *
 * @returns Email form that resolves into a neutral confirmation strip.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  /**
   * Request the reset link. Only a 429 surfaces as an error; everything
   * else resolves to the neutral confirmation.
   *
   * @param event - The form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const { error: authError } = await requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    if (authError && authError.status === 429) {
      setError("Too many requests. Try again in a minute.");
      setLoading(false);
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <p
        role="status"
        className="rounded-md border px-3 py-2.5 text-[12.5px] text-text-secondary"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
          borderColor:
            "color-mix(in srgb, var(--color-accent) 22%, transparent)",
        }}
      >
        If an account exists for that address, a password reset link is on its
        way. The link expires in an hour.
      </p>
    );
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={handleSubmit} noValidate>
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

      <AuthSubmit isLoading={loading}>Send reset link</AuthSubmit>
    </form>
  );
}
