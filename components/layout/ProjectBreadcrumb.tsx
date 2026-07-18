"use client";

import { motion } from "motion/react";
import { TeamChip } from "@/components/shared/TeamChip";

/** Status chip display mapping — mirrors the home ProjectCard. */
const PROJECT_STATUS_DISPLAY: Record<
  string,
  { label: string; dot: string; bg: string; text: string }
> = {
  brainstorming: {
    label: "Idea",
    dot: "bg-accent",
    bg: "bg-accent/15",
    text: "text-accent",
  },
  decomposing: {
    label: "Building",
    dot: "bg-progress",
    bg: "bg-progress/15",
    text: "text-progress",
  },
  active: {
    label: "Active",
    dot: "bg-done",
    bg: "bg-done/15",
    text: "text-done",
  },
  archived: {
    label: "Archived",
    dot: "bg-draft",
    bg: "bg-draft/10",
    text: "text-draft",
  },
};

interface ProjectBreadcrumbProps {
  /** @param projectName - Current project title. */
  projectName: string;
  /** @param projectStatus - Optional project lifecycle status for the inline chip. */
  projectStatus?: string;
  /** @param team - Optional owning team. When provided, renders a TeamChip before the project name. */
  team?: { id: string; name: string };
  /** @param onOpenSettings - Called when the breadcrumb button is clicked. */
  onOpenSettings: () => void;
}

/**
 * Breadcrumb pill that triggers the project settings modal. When a team is
 * supplied, the team chip leads the pill so the owning team is visible at
 * a glance — matches the team chip on home-page project cards so the same
 * hue identifies the same team across the app.
 * @param props - Breadcrumb configuration.
 * @returns Button displaying the team chip, project name, status chip, and pencil icon.
 */
export function ProjectBreadcrumb({
  projectName,
  projectStatus,
  team,
  onOpenSettings,
}: ProjectBreadcrumbProps) {
  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      type="button"
      onClick={onOpenSettings}
      aria-label={`${projectName}, open project settings`}
      title="Project settings"
      className="group/proj flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-md border border-border-strong/40 bg-surface/40 px-2.5 py-1 transition-all hover:border-accent/40 hover:bg-surface-hover"
    >
      {team && (
        <span className="hidden shrink-0 sm:inline-flex">
          <TeamChip team={team} size="xs" />
        </span>
      )}
      <span className="min-w-0 truncate text-sm text-text-secondary group-hover/proj:text-text-primary transition-colors">
        {projectName}
      </span>
      {projectStatus && PROJECT_STATUS_DISPLAY[projectStatus] && (
        <span
          className={`hidden sm:inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${PROJECT_STATUS_DISPLAY[projectStatus].bg} ${PROJECT_STATUS_DISPLAY[projectStatus].text}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${PROJECT_STATUS_DISPLAY[projectStatus].dot}`}
          />
          {PROJECT_STATUS_DISPLAY[projectStatus].label}
        </span>
      )}
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        className="h-3 w-3 shrink-0 text-text-muted transition-all group-hover/proj:text-accent"
        aria-hidden="true"
      >
        <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.1a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.609-8.61a.25.25 0 000-.353l-1.097-1.097z" />
      </svg>
    </motion.button>
  );
}
