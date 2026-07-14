import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { AuthHero } from "@/components/auth/AuthHero";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { SignInForm } from "@/components/auth/SignInForm";
import { safeInviteNext } from "@/lib/auth/invite-next";
import { isEmailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";

interface SignInPageProps {
  searchParams: Promise<{ next?: string }>;
}

/**
 * Sign-in page — two-column auth surface matching the design prototype.
 *
 * Left column hosts the email/password form plus disabled-with-tooltip
 * GitHub and Google buttons (backend providers not yet wired in
 * `lib/auth.ts`). Right column renders the static `AuthHero` mock; the
 * webapp never streams live agent data — Piyaz is MCP-first.
 *
 * A validated `next` query param (invitation CTAs) overrides the default
 * post-sign-in redirect to `/`, where `requireMembership` forwards new
 * accounts to `/onboarding/team`. Email capability is read per request
 * and gates the Forgot-password link.
 *
 * @param props - Route search params carrying the optional `next` value.
 * @returns Server-rendered auth shell composing the client form.
 */
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const next = safeInviteNext((await searchParams).next);
  const passwordResetEnabled = isEmailEnabled();
  return (
    <AuthShell
      form={
        <>
          <AuthBrand />
          <h1
            className="text-[26px] font-semibold text-text-primary"
            style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
          >
            Walk into every session knowing what to do next.
          </h1>
          <p
            className="mb-7 mt-2.5 text-[13.5px] text-text-muted"
            style={{ lineHeight: 1.55 }}
          >
            The agent-native project graph. Sign in to continue, or onboard a
            repo from your CLI.
          </p>

          <SocialButtons />
          <SignInForm passwordResetEnabled={passwordResetEnabled} next={next} />

          <p className="mt-3.5 text-center text-[12px] text-text-muted">
            New to Piyaz?{" "}
            <Link
              href={
                next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"
              }
              className="hover:underline"
              style={{ color: "var(--color-accent-light)" }}
            >
              Create an account
            </Link>
          </p>
        </>
      }
      hero={<AuthHero />}
    />
  );
}
