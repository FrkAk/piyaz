import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ForbiddenError } from "@/lib/auth/authorization";
import { getProjectGraphSlim } from "@/lib/graph/queries";
import { getServerQueryClient } from "@/lib/query/client";
import { projectKeys } from "@/lib/query/keys";
import { GraphRailCollapseProvider } from "@/components/workspace/graph/GraphRailCollapseProvider";
import { WorkspaceClient } from "./_components/WorkspaceClient";

interface WorkspacePageProps {
  /** Route params with the projectId. */
  params: Promise<{ projectId: string }>;
}

/**
 * Workspace page server shell. Prefetches the slim project graph into a
 * per-request QueryClient and dehydrates via `<HydrationBoundary>` so the
 * client `<WorkspaceClient>` paints instantly. Cross-team access surfaces
 * as 404 (matches the layout's behaviour).
 *
 * @param props - Route params.
 * @returns Hydrated workspace shell.
 */
export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { projectId } = await params;

  const qc = getServerQueryClient();
  try {
    const graph = await getProjectGraphSlim(projectId);
    qc.setQueryData(projectKeys.graph(projectId), graph);
  } catch (err) {
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }

  const cookieStore = await cookies();
  const railCollapsed =
    cookieStore.get("mymir-graph-rail-collapsed")?.value === "1";

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <GraphRailCollapseProvider initialCollapsed={railCollapsed}>
        <WorkspaceClient projectId={projectId} />
      </GraphRailCollapseProvider>
    </HydrationBoundary>
  );
}
