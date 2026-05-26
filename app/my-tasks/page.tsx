import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { MyTasksClient } from "@/components/my-tasks/MyTasksClient";
import { getSession } from "@/lib/auth/session";
import { listMyTasks } from "@/lib/graph/queries";
import { getServerQueryClient } from "@/lib/query/client";
import { myTasksKeys } from "@/lib/query/keys";

/** Force dynamic rendering — this page reads the session and DB. */
export const dynamic = "force-dynamic";

/**
 * My tasks — cross-project assigned-task list. RSC prefetches `listMyTasks`
 * into the per-request QueryClient and dehydrates into the client so the
 * first paint is server-rendered. Owns the page scroll container because
 * `AppShell`'s `<main>` is `overflow-hidden` and the design specifies a
 * fixed 1080px content column wider than `PageShell`'s default cap.
 *
 * @returns Hydrated `/my-tasks` shell.
 */
export default async function MyTasksPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const qc = getServerQueryClient();
  const payload = await listMyTasks();
  qc.setQueryData(myTasksKeys.list(), payload.ok ? payload.rows : []);

  return (
    <AppShell>
      <TopBar pageLabel="My tasks" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-8 pt-7 pb-20">
          <HydrationBoundary state={dehydrate(qc)}>
            <MyTasksClient initialError={payload.ok ? null : payload.code} />
          </HydrationBoundary>
        </div>
      </div>
    </AppShell>
  );
}
