import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { MyTasksClient } from "@/components/my-tasks/MyTasksClient";
import { getSession } from "@/lib/auth/session";
import { listMyTasks } from "@/lib/graph/queries";
import { getServerQueryClient } from "@/lib/query/client";
import { myTasksKeys } from "@/lib/query/keys";

export const dynamic = "force-dynamic";

// Owns its own scroll container because AppShell's `<main>` is
// `overflow-hidden` and the column is wider than PageShell's default cap.
export default async function MyTasksPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  const qc = getServerQueryClient();
  const payload = await listMyTasks();
  // Only prime the cache on success. Seeding `[]` on failure would flip
  // useQuery to `isSuccess=true` and suppress the SSR error banner; leaving
  // the cache empty lets the client refetch and surface a real error state.
  if (payload.ok) {
    qc.setQueryData(myTasksKeys.list(), payload.rows);
  }

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
