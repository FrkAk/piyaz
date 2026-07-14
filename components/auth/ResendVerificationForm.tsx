"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { sendVerificationEmail } from "@/lib/auth-client";
import { AuthInput } from "./AuthInput";
import { AuthSubmit } from "./AuthSubmit";

interface ResendVerificationFormProps {
  /** Session email when signed in; renders a free email input when null. */
  email: string | null;
  /** Validated invite return destination threaded through the emailed link. */
  next: string | null;
}

/**
 * Verification-email resend form for the `/verify-email` landing.
 *
 * Always answers a successful send with the neutral "if an account
 * exists" strip — the endpoint 200s for unknown and already-verified
 * addresses (anti-enumeration), so the UI never branches on existence. A
 * signed-in already-verified caller's 400 `EMAIL_ALREADY_VERIFIED` maps
 * to a continue link instead. A 60s cooldown keeps the button quiet
 * under the server's 3/60 rate rule.
 *
 * @param props - Prefilled session email (or null) and return destination.
 * @returns Email form (or fixed-address form) with inline status strips.
 */
export function ResendVerificationForm({
  email,
  next,
}: ResendVerificationFormProps) {
  const [address, setAddress] = useState(email ?? "");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [alreadyVerified, setAlreadyVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callbackURL = next
    ? `/verify-email?next=${encodeURIComponent(next)}`
    : "/verify-email";

  /**
   * Request a fresh verification link. Success and unknown-address both
   * land in the neutral sent state; only rate limiting surfaces an error.
   *
   * @param event - The form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status !== "idle") return;
    setError(null);
    setStatus("sending");
    const { error: authError } = await sendVerificationEmail({
      email: address,
      callbackURL,
    });
    if (authError) {
      if (authError.code === "EMAIL_ALREADY_VERIFIED") {
        setAlreadyVerified(true);
        return;
      }
      setError(
        authError.status === 429
          ? "Too many requests. Try again in a minute."
          : (authError.message ?? "Could not send the email"),
      );
      setStatus("idle");
      return;
    }
    setStatus("sent");
    window.setTimeout(() => setStatus("idle"), 60_000);
  }

  if (alreadyVerified) {
    return (
      <p
        role="status"
        className="rounded-md border px-3 py-2.5 text-center text-[12.5px] text-text-secondary"
        style={{
          background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
          borderColor:
            "color-mix(in srgb, var(--color-accent) 22%, transparent)",
        }}
      >
        That address is already verified.{" "}
        <Link
          href={next ?? "/"}
          className="hover:underline"
          style={{ color: "var(--color-accent-light)" }}
        >
          Continue
        </Link>
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-2.5 text-left"
      onSubmit={handleSubmit}
      noValidate
    >
      {email === null ? (
        <AuthInput
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="you@company.com"
        />
      ) : null}

      {status === "sent" ? (
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
          If an account exists for that address and isn&rsquo;t verified yet, a
          new link is on its way. You can request another in a minute.
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

      <AuthSubmit isLoading={status === "sending"} disabled={status === "sent"}>
        Send verification link
      </AuthSubmit>
    </form>
  );
}
