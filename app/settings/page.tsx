import { redirect } from "next/navigation";
import { TopBar } from "@/components/layout/TopBar";
import { AppShell } from "@/components/layout/AppShell";
import { getSession } from "@/lib/auth/session";
import { listOAuthSessionsAction } from "@/lib/actions/oauth-session";
import { getPasswordUpdatedAt } from "@/lib/data/account";
import { loadUserTeams } from "@/lib/server/request-loaders";
import { SettingsView } from "./_components/SettingsView";

/** Force dynamic rendering — this page reads the session and DB. */
export const dynamic = "force-dynamic";

/**
 * Settings page — sub-shell with a 240px left rail (Account / Teams /
 * Agents & devices / Notifications / Billing) plus a content column.
 * Renders even when the user has no team memberships yet so they can
 * create one without bouncing through `/onboarding/team`.
 *
 * @returns Server-rendered settings shell with hydrated initial data.
 */
export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  // getPasswordUpdatedAt rejects loudly on DB failure (no .ok wrapper):
  // null is semantic ("no credential account" hides the password card),
  // so degrading errors to null would silently remove a security
  // affordance. A thrown error failing the page is the intended posture.
  const [sessionsResult, teamsResult, passwordUpdatedAt] = await Promise.all([
    listOAuthSessionsAction(),
    loadUserTeams(),
    getPasswordUpdatedAt(session.user.id),
  ]);

  const initialSessions = sessionsResult.ok ? sessionsResult.data : [];
  const initialTeams = teamsResult.ok ? teamsResult.data : [];

  return (
    <AppShell>
      <TopBar />
      <SettingsView
        user={{
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          createdAt: session.user.createdAt,
        }}
        passwordUpdatedAt={passwordUpdatedAt}
        initialSessions={initialSessions}
        initialTeams={initialTeams}
      />
    </AppShell>
  );
}
