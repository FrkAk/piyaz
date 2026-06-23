import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { AuthBrand } from "@/components/auth/AuthBrand";
import { AuthHero } from "@/components/auth/AuthHero";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { SignUpForm } from "@/components/auth/SignUpForm";
import { WaitlistForm } from "@/components/auth/WaitlistForm";

const SIGNUPS_DISABLED = process.env.DEPLOY_TARGET === "cloudflare";

/**
 * Sign-up page. Renders the registration form on self-host and an
 * "invite only" notice on the hosted Cloudflare deploy. Post-create the
 * user lands on `/`; `requireMembership` forwards to `/onboarding/team`
 * because a fresh account has zero memberships.
 *
 * @returns Server-rendered auth shell with form or invite-only notice
 *   depending on `DEPLOY_TARGET`.
 */
export default function SignUpPage() {
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
              : "Your project graph and decision history live here. Connect agents through MCP from your CLI once you’re in."}
          </p>

          {SIGNUPS_DISABLED ? (
            <WaitlistForm />
          ) : (
            <>
              <SocialButtons />
              <SignUpForm />
            </>
          )}

          <p className="mt-3.5 text-center text-[12px] text-text-muted">
            {SIGNUPS_DISABLED ? "Already invited?" : "Already have an account?"}{" "}
            <Link
              href="/sign-in"
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
