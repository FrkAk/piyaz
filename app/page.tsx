import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import {
  loadSidebarProjects,
  loadUserTeams,
} from "@/lib/server/request-loaders";
import { requireMembership } from "@/lib/auth/membership";
import { TopBar } from "@/components/layout/TopBar";
import { AppShell } from "@/components/layout/AppShell";
import { PageShell } from "@/components/layout/PageShell";
import { getServerQueryClient } from "@/lib/query/client";
import { projectKeys } from "@/lib/query/keys";
import { HomeGrid } from "@/app/_components/HomeGrid";

/** Force dynamic rendering — this page queries the database. */
export const dynamic = "force-dynamic";

/**
 * Home page server shell. Prefetches the project list + team memberships
 * into a per-request QueryClient and dehydrates the cache via
 * `<HydrationBoundary>` so the client `<HomeGrid>` paints from cache and
 * future invalidations (focus refetch, SSE) flow through Query.
 *
 * @returns Server-rendered shell wrapping the client grid.
 */
export default async function HomePage() {
  await requireMembership();

  const [projects, teamsResult] = await Promise.all([
    loadSidebarProjects(),
    loadUserTeams(),
  ]);

  const teams = teamsResult.ok ? teamsResult.data : [];

  const qc = getServerQueryClient();
  qc.setQueryData(projectKeys.list(), projects);

  return (
    <AppShell>
      <TopBar />
      <PageShell>
        <HydrationBoundary state={dehydrate(qc)}>
          <HomeGrid teams={teams} />
        </HydrationBoundary>
      </PageShell>
    </AppShell>
  );
}
