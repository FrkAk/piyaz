import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { AuthHero } from "@/components/auth/AuthHero";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { SignInForm } from "@/components/auth/SignInForm";
import { WaitlistForm } from "@/components/auth/WaitlistForm";

const SIGNUPS_DISABLED = process.env.DEPLOY_TARGET === "cloudflare";

/**
 * Sign-in page — two-column auth surface matching the design prototype.
 *
 * Left column hosts the email/password form plus disabled-with-tooltip
 * GitHub and Google buttons (backend providers not yet wired in
 * `lib/auth.ts`). Right column renders the static `AuthHero` mock; the
 * webapp never streams live agent data — Piyaz is MCP-first.
 *
 * The post-sign-in redirect targets `/`, where `requireMembership`
 * forwards new accounts to `/onboarding/team`.
 *
 * @returns Server-rendered auth shell composing the client form.
 */
export default function SignInPage() {
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
          <SignInForm />

          {SIGNUPS_DISABLED ? (
            <>
              <p
                className="mb-7 mt-7 text-[13.5px] text-text-muted"
                style={{ lineHeight: 1.55 }}
              >
                Not invited yet? Piyaz is in a closed beta. Join the waitlist
                and we&rsquo;ll email you when accounts open.
              </p>
              <WaitlistForm />
            </>
          ) : (
            <p className="mt-3.5 text-center text-[12px] text-text-muted">
              New to Piyaz?{" "}
              <Link
                href="/sign-up"
                className="hover:underline"
                style={{ color: "var(--color-accent-light)" }}
              >
                Create an account
              </Link>
            </p>
          )}
        </>
      }
      hero={<AuthHero />}
    />
  );
}
