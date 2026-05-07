import { type ReactNode } from 'react';
import { getProjectChrome } from '@/lib/graph/queries';
import { requireMembership } from '@/lib/auth/membership';
import { ForbiddenError } from '@/lib/auth/authorization';
import { roleHasProjectPermission } from '@/lib/auth/permissions';
import { AppShell } from '@/components/layout/AppShell';
import { WorkspaceHeader } from '@/components/workspace/WorkspaceHeader';
import { notFound, redirect } from 'next/navigation';

interface LayoutProps {
  /** @param children - Page content. */
  children: ReactNode;
  /** @param params - Route params with projectId. */
  params: Promise<{ projectId: string }>;
}

/**
 * Project workspace layout with TopBar showing project name and stats.
 * @param props - Layout props with children and route params.
 * @returns Layout with TopBar and content area.
 */
export default async function ProjectLayout({ children, params }: LayoutProps) {
  await requireMembership();
  const { projectId } = await params;

  let project: Awaited<ReturnType<typeof getProjectChrome>>;
  try {
    project = await getProjectChrome(projectId);
  } catch (err) {
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }

  if (project.status === 'brainstorming' || project.status === 'decomposing') {
    redirect('/');
  }

  const canRename = roleHasProjectPermission(project.memberRole, ['rename']);

  return (
    <AppShell>
      <WorkspaceHeader
        projectId={projectId}
        projectName={project.title}
        description={project.description}
        identifier={project.identifier}
        status={project.status}
        categories={project.categories}
        team={{ id: project.organization.id, name: project.organization.name }}
        taskCount={project.taskCount}
        canRename={canRename}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </AppShell>
  );
}
