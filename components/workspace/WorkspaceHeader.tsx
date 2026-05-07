'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TopBar } from '@/components/layout/TopBar';
import { ProjectSettingsModal } from '@/components/workspace/project-settings/ProjectSettingsModal';
import type { ProjectStatus } from '@/lib/types';

interface WorkspaceHeaderProps {
  /** @param projectId - UUID of the project. */
  projectId: string;
  /** @param projectName - Current project title for breadcrumb + modal. */
  projectName: string;
  /** @param description - Current project description for the settings modal. */
  description: string;
  /** @param identifier - Current project identifier (e.g. MYMR). */
  identifier: string;
  /** @param status - Current project lifecycle status (brainstorming → decomposing → active → archived). */
  status: ProjectStatus;
  /** @param categories - Current project categories. */
  categories: string[];
  /** @param team - Owning team — surfaces in the breadcrumb pill and the settings modal header. */
  team: { id: string; name: string };
  /** @param taskCount - Total number of tasks (drives rename warning copy). */
  taskCount: number;
  /** @param canRename - True when the caller's role in the project's team grants identifier rename. */
  canRename: boolean;
}

/**
 * Client-side header for the workspace — renders TopBar with a gear trigger
 * and owns {@link ProjectSettingsModal} open state. Refreshes the server-layout
 * data via router.refresh() after any successful update.
 * @param props - Header props seeded from the server layout.
 * @returns TopBar plus modal.
 */
export function WorkspaceHeader({
  projectId,
  projectName,
  description,
  identifier,
  status,
  categories,
  team,
  taskCount,
  canRename,
}: WorkspaceHeaderProps) {
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Refresh the server-rendered project layout (chrome). The workspace
   * page reacts to graph + task changes via Query invalidations driven by
   * the realtime SSE bridge — only the chrome layout still needs an
   * explicit refresh because it's outside the Query cache.
   */
  const handleUpdated = (): void => {
    router.refresh();
  };

  return (
    <>
      <TopBar
        projectName={projectName}
        projectId={projectId}
        projectStatus={status}
        team={team}
        onOpenProjectSettings={() => setSettingsOpen(true)}
      />
      <ProjectSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        projectId={projectId}
        project={{ title: projectName, description, identifier, status, categories }}
        team={team}
        taskCount={taskCount}
        canRename={canRename}
        onUpdated={handleUpdated}
      />
    </>
  );
}

export default WorkspaceHeader;
