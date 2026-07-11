"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { signUp } from "@/lib/auth-client";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";

/**
 * Email/password sign-up form.
 *
 * On success the user lands on `/`, which `requireMembership` redirects
 * to `/onboarding/team` because a new account starts with zero teams.
 * No special-casing is needed here.
 *
 * Terms acceptance is affirmative: the checkbox paints unchecked and the
 * submit path refuses to call `signUp.email` until it is ticked. The flag
 * rides in the sign-up body so the server-side `user.create.before` gate
 * (`lib/auth.ts`) enforces the same rule against direct API calls.
 *
 * @returns Vertical form: name + email + password + consent + submit.
 */
export function SignUpForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * Create the account via Better Auth. Blocks until Terms are accepted,
   * then sends `termsAccepted` in the body for the server gate. Errors
   * render inline in the danger-tinted strip; on success the App Router
   * picks up the new session and the membership gate takes over.
   *
   * @param event - The form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!termsAccepted) {
      setError("Accept the Terms of Service to continue.");
      return;
    }

    setLoading(true);
    const payload = { name, email, password, termsAccepted };
    const { error: authError } = await signUp.email(payload);

    if (authError) {
      setError(authError.message ?? "Sign up failed");
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={handleSubmit} noValidate>
      <AuthInput
        label="Name"
        type="text"
        autoComplete="name"
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Your name"
      />
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
        autoComplete="new-password"
        required
        minLength={8}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint="At least 8 characters."
        placeholder="••••••••"
      />

      <div className="mt-0.5 flex flex-col gap-1.5">
        <label
          htmlFor="terms-accept"
          className="flex cursor-pointer items-start gap-2.5"
        >
          <input
            id="terms-accept"
            type="checkbox"
            checked={termsAccepted}
            onChange={(event) => setTermsAccepted(event.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] border-border-strong transition-colors peer-checked:border-transparent peer-checked:[background:var(--color-accent-grad)] peer-checked:[&>svg]:opacity-100 peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
          >
            <svg
              viewBox="0 0 12 12"
              width={11}
              height={11}
              aria-hidden="true"
              className="opacity-0 transition-opacity"
            >
              <path
                d="M2 6l3 3 5-5"
                fill="none"
                stroke="#0b0c10"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-[12.5px] leading-snug text-text-secondary">
            I accept the{" "}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: "var(--color-accent-light)" }}
            >
              Terms of Service
            </a>
          </span>
        </label>
        <p className="pl-[26px] text-[12px] leading-snug text-text-muted">
          I have read the{" "}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            style={{ color: "var(--color-accent-light)" }}
          >
            Privacy Policy
          </a>
        </p>
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

      <AuthSubmit isLoading={loading}>Create account</AuthSubmit>
    </form>
  );
}
