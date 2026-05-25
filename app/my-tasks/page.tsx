import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { getSession } from "@/lib/auth/session";
import { listTasksAssignedToUser } from "@/lib/graph/queries";
import { getServerQueryClient } from "@/lib/query/client";
import { myTasksKeys } from "@/lib/query/keys";
import { MyTasksClient } from "./_components/MyTasksClient";

/** Force dynamic rendering — this page reads the session and DB. */
export const dynamic = "force-dynamic";

/**
 * My tasks — flat cross-project list of every task assigned to the
 * signed-in user, grouped by project. Default filter hides terminal /
 * draft statuses; a client-side toggle reveals them without a refetch.
 *
 * @returns Hydrated `/my-tasks` shell.
 */
export default async function MyTasksPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const qc = getServerQueryClient();
  const payload = await listTasksAssignedToUser();
  qc.setQueryData(myTasksKeys.list(), payload.ok ? payload.rows : []);

  return (
    <AppShell>
      <TopBar pageLabel="My tasks" />
      <HydrationBoundary state={dehydrate(qc)}>
        <MyTasksClient initialError={payload.ok ? null : payload.code} />
      </HydrationBoundary>
    </AppShell>
  );
}
