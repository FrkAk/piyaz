import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { AuthHero } from "@/components/auth/AuthHero";
import { AuthLinkButton } from "@/components/auth/AuthLinkButton";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

const MARKETING_URL = "https://piyaz.ai";

export const dynamic = "force-dynamic";

interface ResetPasswordPageProps {
  searchParams: Promise<{ token?: string; error?: string }>;
}

/**
 * Password-reset completion page. Better Auth's emailed link hits
 * `/api/auth/reset-password/<token>`, validates server-side, and
 * redirects here — with `?token=` when the token is live and
 * `?error=INVALID_TOKEN` when it is not. A missing token (direct
 * navigation) renders the same invalid-link panel as an error.
 *
 * @param props - Route search params (`token`, `error`).
 * @returns Server-rendered auth shell with the new-password form or the
 *   invalid-link panel.
 */
export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { token, error } = await searchParams;
  const invalid = typeof error === "string" || !token;
  return (
    <AuthShell
      form={
        <>
          <AuthBrand href={MARKETING_URL} />
          <span
            className="mb-2 block font-mono text-[10px] font-semibold uppercase"
            style={{
              color: "var(--color-accent-light)",
              letterSpacing: "0.14em",
            }}
          >
            Password reset
          </span>
          <h1
            className="text-[26px] font-semibold text-text-primary"
            style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
          >
            {invalid ? "This link has expired" : "Choose a new password"}
          </h1>
          <p
            className="mb-7 mt-2.5 text-[13.5px] text-text-muted"
            style={{ lineHeight: 1.55 }}
          >
            {invalid
              ? "Password reset links are single-use and expire after an hour."
              : "Pick a new password for your account. Your other sessions will be signed out."}
          </p>

          {invalid ? (
            <AuthLinkButton href="/forgot-password">
              Request a new link
            </AuthLinkButton>
          ) : (
            <ResetPasswordForm token={token} />
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
