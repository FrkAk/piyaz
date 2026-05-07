import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { ForbiddenError } from "@/lib/auth/authorization";
import { getProjectGraphSlim } from "@/lib/graph/queries";
import { getServerQueryClient } from "@/lib/query/client";
import { projectKeys } from "@/lib/query/keys";
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

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <WorkspaceClient projectId={projectId} />
    </HydrationBoundary>
  );
}
