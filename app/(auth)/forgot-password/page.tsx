import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { AuthEyebrow } from "@/components/auth/AuthEyebrow";
import { AuthHero } from "@/components/auth/AuthHero";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { MARKETING_URL } from "@/lib/config/urls";
import { isEmailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Password-reset request page. Public: the audience is signed-out users
 * locked out of their account. Email capability is read per request —
 * deploys without a transport get an honest notice instead of a form
 * that silently sends nothing.
 *
 * @returns Server-rendered auth shell composing the request form.
 */
export default function ForgotPasswordPage() {
  const emailEnabled = isEmailEnabled();
  return (
    <AuthShell
      form={
        <>
          <AuthBrand href={MARKETING_URL} />
          <AuthEyebrow>Password reset</AuthEyebrow>
          <h1
            className="text-[26px] font-semibold text-text-primary"
            style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
          >
            Reset your password
          </h1>
          <p
            className="mb-7 mt-2.5 text-[13.5px] text-text-muted"
            style={{ lineHeight: 1.55 }}
          >
            Enter your account&rsquo;s email address and we&rsquo;ll send you a
            link to choose a new one.
          </p>

          {emailEnabled ? (
            <ForgotPasswordForm />
          ) : (
            <p
              role="status"
              className="rounded-md border border-border bg-base px-3 py-2.5 text-[12.5px] leading-relaxed text-text-secondary"
            >
              Password reset by email isn&rsquo;t available on this deployment.
              Contact your administrator to reset your password.
            </p>
          )}

          <p className="mt-3.5 text-center text-[12px] text-text-muted">
            Remembered it?{" "}
            <Link
              href="/sign-in"
              className="hover:underline"
              style={{ color: "var(--color-accent-light)" }}
            >
              Back to sign in
            </Link>
          </p>
        </>
      }
      hero={<AuthHero />}
    />
  );
}
