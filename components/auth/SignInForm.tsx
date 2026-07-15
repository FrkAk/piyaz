"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";

interface SignInFormProps {
  /** Whether the deploy can deliver reset emails; gates the Forgot-password link. */
  passwordResetEnabled: boolean;
  /** Validated invite return destination; falls back to `/` after sign-in. */
  next?: string | null;
}

/**
 * Email/password sign-in form.
 *
 * Wires straight into the existing Better Auth client (`signIn.email`).
 * On success we push to the validated `next` destination (invite CTAs) or
 * `/` — `requireMembership` on the home page cascades to
 * `/onboarding/team` for accounts with no team yet, so the home target
 * works for both repeat and fresh-signup users.
 *
 * @param props - Reset-link capability flag and optional return destination.
 * @returns Vertical form: email + password + Forgot link + submit.
 */
export function SignInForm({
  passwordResetEnabled,
  next = null,
}: SignInFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * Submit credentials to Better Auth. A gated unverified account gets
   * the check-your-inbox explanation (BA's `sendOnSignIn` fires a fresh
   * verification link on the same blocked attempt); other errors surface
   * the server-provided message inline. On success we let the App Router
   * pick up the new session via push + refresh.
   *
   * @param event - The form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const { error: authError } = await signIn.email({ email, password });

    if (authError) {
      setError(
        authError.code === "EMAIL_NOT_VERIFIED"
          ? "Your email address isn’t verified yet. We’ve emailed you a new verification link. Check your inbox."
          : (authError.message ?? "Sign in failed"),
      );
      setLoading(false);
      return;
    }

    router.push(next ?? "/");
    router.refresh();
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
      <AuthInput
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        minLength={8}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="••••••••"
      />

      <div className="flex items-center justify-end pt-0.5">
        {passwordResetEnabled ? (
          <Link
            href="/forgot-password"
            className="text-[11.5px] text-text-muted underline-offset-2 hover:text-text-secondary hover:underline"
          >
            Forgot password?
          </Link>
        ) : (
          <button
            type="button"
            disabled
            title="Password reset requires email delivery"
            aria-label="Password reset requires email delivery"
            className="cursor-not-allowed text-[11.5px] text-text-muted underline-offset-2 opacity-80 hover:underline"
          >
            Forgot password?
          </button>
        )}
      </div>

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

      <AuthSubmit isLoading={loading}>Sign in</AuthSubmit>
    </form>
  );
}
