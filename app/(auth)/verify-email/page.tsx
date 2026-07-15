import Link from "next/link";
import { AuthLinkButton } from "@/components/auth/AuthLinkButton";
import { AuthStatusFrame } from "@/components/auth/AuthStatusFrame";
import { ResendVerificationForm } from "@/components/auth/ResendVerificationForm";
import { safeInviteNext } from "@/lib/auth/invite-next";
import { getSession } from "@/lib/auth/session";
import { isEmailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";

interface VerifyEmailPageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

/**
 * Verification landing. Better Auth's emailed link hits
 * `/api/auth/verify-email`, verifies server-side, then redirects here —
 * with no query on success (minting the session via
 * `autoSignInAfterVerification`) and with `?error=<code>` on a bad or
 * reused token. The page never re-verifies the token; it derives its
 * state from the error param and session:
 *
 * - no error + verified session → success
 * - no error + unverified session or no session → pending (resend)
 * - error + verified session → the link was already used; still verified
 * - error otherwise → expired/invalid (resend)
 *
 * The resend form and the send/resend promises in the pending copy render
 * only when email delivery is enabled, read server-side per request, so
 * email-incapable deploys never promise a send the panel then denies. A
 * validated `next` param (invitation CTAs) carries through the resend's
 * callback and the continue targets.
 *
 * @param props - Route search params (`error`, `next`).
 * @returns Centered status panel with continue CTA or resend form.
 */
export default async function VerifyEmailPage({
  searchParams,
}: VerifyEmailPageProps) {
  const params = await searchParams;
  const next = safeInviteNext(params.next);
  const hasError = typeof params.error === "string" && params.error.length > 0;
  const session = await getSession();
  const verified = session?.user.emailVerified === true;
  const emailEnabled = isEmailEnabled();

  const state = hasError
    ? verified
      ? "already-verified"
      : "expired"
    : verified
      ? "success"
      : "pending";

  const heading =
    state === "success"
      ? "Email verified"
      : state === "already-verified"
        ? "Already verified"
        : state === "expired"
          ? "This link has expired"
          : session
            ? "Check your email"
            : "Verify your email";

  return (
    <AuthStatusFrame eyebrow="Email verification" heading={heading}>
      {state === "success" ? (
        <p
          className="text-center text-sm text-text-muted"
          style={{ lineHeight: 1.55 }}
        >
          Your email address is confirmed and you&rsquo;re signed in.
        </p>
      ) : null}
      {state === "already-verified" ? (
        <p
          className="text-center text-sm text-text-muted"
          style={{ lineHeight: 1.55 }}
        >
          That link was already used, but your email address is verified.
        </p>
      ) : null}
      {state === "expired" ? (
        <p
          className="text-center text-sm text-text-muted"
          style={{ lineHeight: 1.55 }}
        >
          This verification link is invalid or has expired.
        </p>
      ) : null}
      {state === "pending" && session ? (
        <p
          className="text-center text-sm text-text-muted"
          style={{ lineHeight: 1.55 }}
        >
          {emailEnabled ? (
            <>
              We sent a verification link to{" "}
              <span className="font-mono text-text-primary">
                {session.user.email}
              </span>
              . Open it to activate your account.
            </>
          ) : (
            <>
              Your email address{" "}
              <span className="font-mono text-text-primary">
                {session.user.email}
              </span>{" "}
              hasn&rsquo;t been verified yet.
            </>
          )}
        </p>
      ) : null}
      {state === "pending" && !session && emailEnabled ? (
        <p
          className="text-center text-sm text-text-muted"
          style={{ lineHeight: 1.55 }}
        >
          Enter your account&rsquo;s email address and we&rsquo;ll send you a
          new verification link.
        </p>
      ) : null}

      {state === "success" || state === "already-verified" ? (
        <AuthLinkButton href={next ?? "/"}>Continue</AuthLinkButton>
      ) : emailEnabled ? (
        <ResendVerificationForm
          email={session?.user.email ?? null}
          next={next}
        />
      ) : (
        <p
          role="status"
          className="rounded-md border border-border bg-base px-3 py-2.5 text-center text-[12.5px] leading-relaxed text-text-secondary"
        >
          Email delivery isn&rsquo;t available on this deployment, so a new link
          can&rsquo;t be sent from here.
        </p>
      )}

      {(state === "pending" || state === "expired") && !session ? (
        <p className="text-center text-[12px] text-text-muted">
          <Link
            href="/sign-in"
            className="hover:underline"
            style={{ color: "var(--color-accent-light)" }}
          >
            Back to sign in
          </Link>
        </p>
      ) : null}
    </AuthStatusFrame>
  );
}
