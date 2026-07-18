"use client";

import { useState, type FormEvent } from "react";
import { resetPassword } from "@/lib/auth-client";
import { PASSWORD_HINT, PASSWORD_MIN } from "@/lib/auth/password-policy";
import { AuthLinkButton } from "./AuthLinkButton";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";

interface ResetPasswordFormProps {
  /** Single-use reset token from Better Auth's redirect (`?token=`). */
  token: string;
}

/**
 * New-password form for `/reset-password`.
 *
 * Submits `resetPassword({ newPassword, token })`; Better Auth revokes
 * the user's other sessions on success. A submit-time `INVALID_TOKEN`
 * (link already used or expired between page load and submit) swaps to
 * the invalid-link panel pointing back at `/forgot-password`.
 *
 * @param props - The reset token carried by the page's query.
 * @returns Password form resolving into a success or invalid-link panel.
 */
export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<"form" | "success" | "invalid">(
    "form",
  );

  /**
   * Set the new password against the token. Token failures degrade to
   * the invalid-link panel; other errors surface inline.
   *
   * @param event - The form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const { error: authError } = await resetPassword({
      newPassword: password,
      token,
    });
    if (authError) {
      if (authError.code === "INVALID_TOKEN") {
        setOutcome("invalid");
        return;
      }
      setError(authError.message ?? "Password reset failed");
      setLoading(false);
      return;
    }
    setOutcome("success");
  }

  if (outcome === "success") {
    return (
      <div className="flex flex-col gap-3">
        <p
          role="status"
          className="rounded-md border px-3 py-2.5 text-[12.5px] text-text-secondary"
          style={{
            background:
              "color-mix(in srgb, var(--color-accent) 8%, transparent)",
            borderColor:
              "color-mix(in srgb, var(--color-accent) 22%, transparent)",
          }}
        >
          Your password has been updated and other sessions were signed out.
          Sign in with the new password to continue.
        </p>
        <AuthLinkButton href="/sign-in">Sign in</AuthLinkButton>
      </div>
    );
  }

  if (outcome === "invalid") {
    return (
      <div className="flex flex-col gap-3">
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
          This reset link is invalid or has expired. Request a new one to
          continue.
        </p>
        <AuthLinkButton href="/forgot-password">
          Request a new link
        </AuthLinkButton>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={handleSubmit} noValidate>
      <AuthInput
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint={PASSWORD_HINT}
        placeholder="••••••••"
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

      <AuthSubmit isLoading={loading}>Set new password</AuthSubmit>
    </form>
  );
}
