"use client";

import { useState, type FormEvent } from "react";
import { sendVerificationEmail, signUp } from "@/lib/auth-client";
import { NAME_MAX } from "@/lib/auth/name-policy";
import { PASSWORD_HINT, PASSWORD_MIN } from "@/lib/auth/password-policy";
import { IconMail } from "@/components/shared/icons";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";
import { TurnstileGate, useTurnstile } from "./TurnstileGate";
import { turnstileFetchOptions } from "./turnstile-state";

interface SignUpFormProps {
  /** True when sign-up sends a verification email (email enabled AND the verification gate is on). */
  verificationPending: boolean;
  /** Validated invite return destination; falls back to `/` after sign-up. */
  next?: string | null;
  /** Public Turnstile site key; `null` disables bot protection (self-host). */
  turnstileSiteKey?: string | null;
  /** Per-request CSP nonce for Turnstile's injected script. */
  nonce?: string;
}

/**
 * Email/password sign-up form.
 *
 * When `verificationPending` is false the user lands on the validated
 * `next` destination or `/`, which `requireMembership` redirects to
 * `/onboarding/team` because a new account starts with zero teams. When
 * it is true, the sign-up body carries `callbackURL` pointing at the
 * `/verify-email` landing (threading `next` through its query) and the
 * form swaps to a check-your-email panel with a cooldown-limited resend.
 *
 * Terms acceptance is affirmative: the checkbox paints unchecked and the
 * submit path refuses to call `signUp.email` until it is ticked. The flag
 * rides in the sign-up body so the server-side `user.create.before` gate
 * (`lib/auth.ts`) enforces the same rule against direct API calls.
 *
 * The name is guarded twice for the same reason, and by neither the field's
 * `required`: the form is `noValidate`, so browser constraint validation never
 * runs. `maxLength` still caps typing (an input constraint rather than a
 * validation one) and the submit path rejects a blank name, so neither an
 * over-long nor an empty name spends a round trip or a captcha token. The
 * `user.create.before` gate in `lib/auth.ts` owns the rule itself.
 *
 * @param props - Verification-flow flag and optional return destination.
 * @returns Vertical form: name + email + password + consent + submit.
 */
export function SignUpForm({
  verificationPending,
  next = null,
  turnstileSiteKey = null,
  nonce,
}: SignUpFormProps) {
  const turnstile = useTurnstile(turnstileSiteKey);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // `cooling` is the just-signed-up state: the sign-up already sent a link, so
  // the server would withhold a resend for the same minute a click-through
  // would report as sent. `sent` acknowledges a resend request; its strip
  // asserts only that mail has been emailed, because the hourly cap can still
  // withhold the send behind this path's neutral 200.
  const [resendStatus, setResendStatus] = useState<
    "idle" | "cooling" | "sending" | "sent"
  >("idle");

  const callbackURL = next
    ? `/verify-email?next=${encodeURIComponent(next)}`
    : "/verify-email";

  /**
   * Create the account via Better Auth, acquiring the captcha token at
   * submit time (the button shows the verifying label while the challenge
   * resolves). Blocks until Terms are accepted, then sends `termsAccepted`
   * in the body for the server gate. Errors render inline in the
   * danger-tinted strip; on success either the check-your-email panel takes
   * over (verification flow) or we hard-navigate to the destination so the
   * app root loads as a fresh document and the membership gate takes over.
   *
   * @param event - The form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (name.trim().length === 0) {
      setError("Enter your name.");
      return;
    }

    if (!termsAccepted) {
      setError("Accept the Terms of Service to continue.");
      return;
    }

    setLoading(true);

    let fetchOptions: ReturnType<typeof turnstileFetchOptions>;
    if (turnstile.enabled) {
      const token = await turnstile.getToken();
      if (token === null) {
        setError(turnstile.blockedMessage());
        setLoading(false);
        return;
      }
      fetchOptions = turnstileFetchOptions(token);
    }

    const payload = {
      name,
      email,
      password,
      termsAccepted,
      callbackURL,
      ...(fetchOptions && { fetchOptions }),
    };
    const { error: authError } = await signUp.email(payload);

    if (authError) {
      setError(authError.message ?? "Sign up failed");
      setLoading(false);
      turnstile.reset();
      return;
    }

    if (verificationPending) {
      // The sign-up spent the token. Clearing it keeps the pending panel's
      // resend button gated until the remounted widget mints a fresh one,
      // instead of replaying the spent token.
      turnstile.reset();
      setSentTo(email);
      setResendStatus("cooling");
      window.setTimeout(() => setResendStatus("idle"), 60_000);
      setLoading(false);
      return;
    }

    window.location.href = next ?? "/";
  }

  /**
   * Re-send the verification email to the address that just signed up,
   * preserving the `/verify-email` callback. The captcha token is acquired
   * at click time. The 60s button cooldown mirrors the server's per-address
   * minimum gap (`lib/email/budget.ts`), which withholds a closer send
   * without saying so on this path: the endpoint answers unknown and
   * already-verified addresses identically, so it cannot report a withheld
   * send to a caller it has not authenticated.
   */
  async function handleResend() {
    if (sentTo === null || resendStatus !== "idle") return;
    setError(null);
    setResendStatus("sending");

    let fetchOptions: ReturnType<typeof turnstileFetchOptions>;
    if (turnstile.enabled) {
      const token = await turnstile.getToken();
      if (token === null) {
        setError(turnstile.blockedMessage());
        setResendStatus("idle");
        return;
      }
      fetchOptions = turnstileFetchOptions(token);
    }

    const { error: resendError } = await sendVerificationEmail({
      email: sentTo,
      callbackURL,
      ...(fetchOptions && { fetchOptions }),
    });
    if (resendError) {
      setError(resendError.message ?? "Could not resend the email");
      setResendStatus("idle");
      turnstile.reset();
      return;
    }
    turnstile.reset();
    setResendStatus("sent");
    window.setTimeout(() => setResendStatus("idle"), 60_000);
  }

  if (sentTo !== null) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <IconMail size={18} style={{ color: "var(--color-accent-light)" }} />
          <h2 className="text-[16px] font-semibold text-text-primary">
            Check your email
          </h2>
        </div>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          We sent a verification link to{" "}
          <span className="font-mono text-text-primary">{sentTo}</span>. Open it
          to activate your account and sign in.
        </p>
        {resendStatus === "sent" ? (
          <p
            role="status"
            className="rounded-md border border-border bg-base px-3 py-2 text-[12px] leading-relaxed text-text-secondary"
          >
            A verification link has been emailed. Check your inbox, and wait a
            minute before requesting another.
          </p>
        ) : null}
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
        <button
          type="button"
          onClick={handleResend}
          disabled={resendStatus !== "idle"}
          className={`self-start text-[12px] underline-offset-2 ${
            resendStatus === "idle"
              ? "cursor-pointer text-text-muted hover:text-text-secondary hover:underline"
              : "cursor-not-allowed text-text-faint"
          }`}
        >
          {resendStatus === "sending"
            ? "Sending…"
            : resendStatus === "cooling"
              ? "Resend available in a minute"
              : "Resend email"}
        </button>
        <TurnstileGate
          siteKey={turnstileSiteKey}
          nonce={nonce}
          {...turnstile.gateProps}
        />
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={handleSubmit} noValidate>
      <AuthInput
        label="Name"
        type="text"
        autoComplete="name"
        required
        maxLength={NAME_MAX}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Your name"
      />
      <AuthInput
        label="Email"
        type="email"
        autoComplete="username"
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
        minLength={PASSWORD_MIN}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint={PASSWORD_HINT}
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

      <AuthSubmit isLoading={loading} loadingLabel={turnstile.verifyingLabel}>
        Create account
      </AuthSubmit>
      <TurnstileGate
        siteKey={turnstileSiteKey}
        nonce={nonce}
        {...turnstile.gateProps}
      />
    </form>
  );
}
