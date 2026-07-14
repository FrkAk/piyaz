import Link from "next/link";
import { AuthStatusFrame } from "@/components/auth/AuthStatusFrame";

/**
 * Post-deletion landing. Better Auth's emailed confirmation link
 * completes at `/api/auth/delete-user/callback`, clears the session,
 * and redirects here via the `callbackURL` threaded through
 * `deleteAccountAction`. The session is already gone when this renders,
 * so the page is static and reads nothing.
 *
 * @returns Centered confirmation with a quiet path back to sign-up.
 */
export default function AccountDeletedPage() {
  return (
    <AuthStatusFrame heading="Account deleted">
      <p
        className="text-center text-sm text-text-muted"
        style={{ lineHeight: 1.55 }}
      >
        Your account and its data have been removed. Thanks for trying Piyaz.
      </p>
      <p className="text-center text-[12px] text-text-muted">
        Changed your mind?{" "}
        <Link
          href="/sign-up"
          className="hover:underline"
          style={{ color: "var(--color-accent-light)" }}
        >
          Create a new account
        </Link>
      </p>
    </AuthStatusFrame>
  );
}
