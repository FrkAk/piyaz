"use client";

import { createContext, useContext, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";

type SessionState = ReturnType<typeof useSession>;

const SessionContext = createContext<SessionState | null>(null);

/**
 * Paths that don't require a valid session. Must cover every unauthenticated
 * page in the middleware `isPublicPath` allowlist, or this client-side guard
 * bounces signed-out visitors off public pages after they render.
 */
const PUBLIC_PATHS = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/account-deleted",
  "/privacy",
  "/terms",
  "/impressum",
  "/subprocessors",
  "/dpa",
];

/**
 * Client counterpart of the middleware's public-path rules: exact matches
 * plus the invitation detail prefix. Deliberately omits `/consent`, which
 * middleware exempts: the OAuth consent surface needs a session
 * client-side, so this guard's sign-in bounce is correct there.
 *
 * @param pathname - Current route pathname.
 * @returns True when the path renders without a session.
 */
function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) || pathname.startsWith("/invitations/")
  );
}

/**
 * Provides reactive auth session state to client components.
 * Redirects to /sign-in when session validation fails (stale cookie,
 * expired session, or DB mismatch). This is the client-side fallback
 * for the proxy's lightweight cookie-presence check.
 * @param props - Provider props with children.
 * @returns Context provider wrapping children with session data.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (session.isPending) return;
    if (isPublicPath(pathname)) return;
    if (!session.data) {
      router.replace("/sign-in");
    }
  }, [session.isPending, session.data, pathname, router]);

  const shouldHide =
    !session.isPending && !session.data && !isPublicPath(pathname);

  return (
    <SessionContext.Provider value={session}>
      {shouldHide ? null : children}
    </SessionContext.Provider>
  );
}

/**
 * Access the current auth session from any client component.
 * Must be used within a SessionProvider.
 * @returns Current session context with data, isPending, and error.
 * @throws Error if used outside SessionProvider.
 */
export function useAuth() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useAuth must be used within SessionProvider");
  return ctx;
}
