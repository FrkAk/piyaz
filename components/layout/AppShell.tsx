import { type ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { listProjectsSlim } from "@/lib/graph/queries";
import { listUserTeamsAction } from "@/lib/actions/team-list";
import {
  Sidebar,
  type SidebarProject,
  type SidebarTeam,
  type SidebarUser,
} from "@/components/layout/Sidebar";
import { WorkspaceLabelProvider } from "@/components/layout/WorkspaceLabelProvider";
import { SidebarCollapseProvider } from "@/components/layout/SidebarCollapseProvider";
import { CommandPaletteProvider } from "@/components/layout/CommandPaletteProvider";

/** Cookie that persists the sidebar collapse preference. Mirrors the constant in `SidebarCollapseProvider`. */
const SIDEBAR_COLLAPSE_COOKIE = "mymir-sidebar-collapsed";

interface AppShellProps {
  /** @param children - Page content rendered inside the main column. */
  children: ReactNode;
}

/**
 * Authenticated app shell — left sidebar + main column. Server component
 * that loads the session, project list, and team list once per request and
 * threads them into the (client) {@link Sidebar}. Pages render their own
 * TopBar at the top of `children`, in flow.
 *
 * Below the `lg` breakpoint the sidebar is hidden and the main column takes
 * the full width. Mobile drawer / icon-rail variants are deliberately out
 * of scope for Phase 1 and left as polish.
 *
 * @param props - Page content.
 * @returns Sidebar + main column wrapper.
 */
export async function AppShell({ children }: AppShellProps) {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const [projects, teamsResult, cookieStore] = await Promise.all([
    listProjectsSlim(),
    listUserTeamsAction(),
    cookies(),
  ]);
  const initialSidebarCollapsed =
    cookieStore.get(SIDEBAR_COLLAPSE_COOKIE)?.value === "1";

  const teams = teamsResult.ok ? teamsResult.data : [];
  const sidebarProjects: SidebarProject[] = projects.map((p) => ({
    id: p.id,
    identifier: p.identifier,
    title: p.title,
    organizationId: p.organizationId,
  }));
  const sidebarTeams: SidebarTeam[] = teams.map((t) => ({
    id: t.id,
    name: t.name,
  }));

  const user: SidebarUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    image: session.user.image ?? null,
  };

  const workspaceLabel =
    teams.length === 1
      ? teams[0].name
      : session.user.name?.trim() || session.user.email;

  return (
    <WorkspaceLabelProvider value={workspaceLabel}>
      <SidebarCollapseProvider initialCollapsed={initialSidebarCollapsed}>
        <CommandPaletteProvider projects={sidebarProjects}>
          <div className="flex h-[var(--viewport-height)] overflow-hidden">
            <Sidebar
              user={user}
              workspaceLabel={workspaceLabel}
              projects={sidebarProjects}
              teams={sidebarTeams}
            />
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {children}
            </main>
          </div>
        </CommandPaletteProvider>
      </SidebarCollapseProvider>
    </WorkspaceLabelProvider>
  );
}

export default AppShell;
