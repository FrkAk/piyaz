import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { AuthHero } from "@/components/auth/AuthHero";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { SignUpForm } from "@/components/auth/SignUpForm";
import { WaitlistForm } from "@/components/auth/WaitlistForm";
import { emailVerificationRequired, signupsDisabled } from "@/lib/config/env";
import { safeInviteNext } from "@/lib/auth/invite-next";
import { isEmailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";

const SIGNUPS_DISABLED = signupsDisabled();

interface SignUpPageProps {
  searchParams: Promise<{ next?: string }>;
}

/**
 * Sign-up page. Renders the registration form when signups are open
 * (self-host and dev) and an "invite only" notice when they are disabled
 * (hosted prod). Post-create the user lands on the validated `next`
 * destination (invitation CTAs) or `/`; `requireMembership` forwards to
 * `/onboarding/team` because a fresh account has zero memberships.
 *
 * `verificationPending` is computed per request: only when email delivery
 * is enabled AND the verification gate is on does sign-up actually send a
 * mail, so only then does the form show its check-your-email state.
 *
 * @param props - Route search params carrying the optional `next` value.
 * @returns Server-rendered auth shell with form or invite-only notice
 *   depending on `signupsDisabled()`.
 */
export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const next = safeInviteNext((await searchParams).next);
  const verificationPending = isEmailEnabled() && emailVerificationRequired();
  return (
    <AuthShell
      form={
        <>
          <AuthBrand />
          <h1
            className="text-[26px] font-semibold text-text-primary"
            style={{ letterSpacing: "-0.01em", lineHeight: 1.15 }}
          >
            {SIGNUPS_DISABLED ? "Invite only for now." : "Create an account."}
          </h1>
          <p
            className="mb-7 mt-2.5 text-[13.5px] text-text-muted"
            style={{ lineHeight: 1.55 }}
          >
            {SIGNUPS_DISABLED
              ? "Piyaz is in a closed beta. New accounts are opening soon, so sign-ups are invite-only for now."
              : "Create your workspace, invite your team, and connect your agents from any harness."}
          </p>

          {SIGNUPS_DISABLED ? (
            <WaitlistForm />
          ) : (
            <>
              <SocialButtons />
              <SignUpForm
                verificationPending={verificationPending}
                next={next}
              />
            </>
          )}

          <p className="mt-3.5 text-center text-[12px] text-text-muted">
            {SIGNUPS_DISABLED ? "Already invited?" : "Already have an account?"}{" "}
            <Link
              href={
                next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"
              }
              className="hover:underline"
              style={{ color: "var(--color-accent-light)" }}
            >
              Sign in
            </Link>
          </p>
        </>
      }
      hero={<AuthHero />}
    />
  );
}
