import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { MyTasksClient } from "@/components/my-tasks/MyTasksClient";
import { requireLegalConsent } from "@/lib/auth/consent";
import { getSession } from "@/lib/auth/session";
import { listMyTasks } from "@/lib/graph/queries";
import { getServerQueryClient } from "@/lib/query/client";
import { myTasksKeys } from "@/lib/query/keys";

export const dynamic = "force-dynamic";

// `MyTasksClient` owns its own scroll container (`flex-1 overflow-y-auto`)
// so the virtualizer in `MyTasksList` can reference the same DOM node — the
// scroll element has to live on the client side. AppShell's `<main>` is
// `overflow-hidden` so the inner scroll is the only one on the page.
export default async function MyTasksPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  await requireLegalConsent(session.user.id);

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
      <HydrationBoundary state={dehydrate(qc)}>
        <MyTasksClient initialError={payload.ok ? null : payload.code} />
      </HydrationBoundary>
    </AppShell>
  );
}
