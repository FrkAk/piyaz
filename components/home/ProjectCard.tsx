"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TeamChip } from "@/components/shared/TeamChip";
import {
  ProjectStatusModal,
  type CliManagedStatus,
} from "@/components/home/ProjectStatusModal";
import { IconMore, IconTrash } from "@/components/shared/icons";
import { projectColor } from "@/lib/ui/project-color";
import { deleteProjectAction } from "@/lib/actions/project";
import { projectKeys } from "@/lib/query/keys";
import type { ProjectTaskStats } from "@/lib/data/views";

interface ProjectCardProps {
  /** @param id - Project ID. */
  id: string;
  /** @param identifier - Human-readable project identifier (handle). */
  identifier: string;
  /** @param title - Project title. */
  title: string;
  /** @param description - Short project description. */
  description: string;
  /** @param status - Project lifecycle status. */
  status: string;
  /** @param taskStats - Per-status task counts driving the percent label and lifecycle bar. */
  taskStats: ProjectTaskStats;
  /** @param lastActive - Relative time string. */
  lastActive: string;
  /** @param canDelete - True when the caller's role grants delete in the owning team. */
  canDelete: boolean;
  /** @param team - Owning team — rendered as a {@link TeamChip} in the footer when shown. */
  team?: { id: string; name: string };
}

/**
 * Status values handled by {@link ProjectStatusModal} when a workspace open
 * is not appropriate (project still in CLI lifecycle).
 *
 * @param status - Project lifecycle status.
 * @returns True for `brainstorming` / `decomposing`.
 */
function isCliManagedStatus(status: string): status is CliManagedStatus {
  return status === "brainstorming" || status === "decomposing";
}

/**
 * Card displaying a project summary with lifecycle bar, brand mark, and
 * inline delete confirm. Workspace-ready projects link into the workspace;
 * CLI-managed projects open a status modal so the user knows to continue
 * from their coding agent.
 *
 * @param props - Project data for rendering.
 * @returns A linked or button-wrapped project card element.
 */
export function ProjectCard({
  id,
  identifier,
  title,
  description,
  status,
  taskStats,
  lastActive,
  canDelete,
  team,
}: ProjectCardProps) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => deleteProjectAction(id),
    onSuccess: (result) => {
      if (result.ok) {
        qc.invalidateQueries({ queryKey: projectKeys.list() });
        return;
      }
      setDeleteError(result.message);
      setConfirming(false);
    },
  });
  const opensWorkspace = status === "active" || status === "archived";
  const activeTotal = Math.max(taskStats.total - taskStats.cancelled, 0);
  const percent =
    activeTotal > 0 ? Math.round((taskStats.done / activeTotal) * 100) : 0;
  const color = projectColor(identifier);
  const initial = (identifier[0] ?? title[0] ?? "?").toUpperCase();

  /** Two-step delete: first click arms confirmation; second runs the server action via useMutation. */
  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirming) {
        setConfirming(true);
        setMenuOpen(false);
        setDeleteError(null);
        return;
      }
      deleteMutation.mutate();
    },
    [confirming, deleteMutation],
  );

  /** Cancel the delete confirm without firing the action. */
  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirming(false);
    setDeleteError(null);
  }, []);

  /** Toggle the card's overflow menu, swallowing the click so it doesn't bubble to the card link. */
  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((v) => !v);
  }, []);

  /** Open the CLI-status modal when the user clicks a non-workspace card. */
  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    setModalOpen(true);
  }, []);

  /** Keyboard equivalent for the CLI-status card click. */
  const handleCardKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setModalOpen(true);
    }
  }, []);

  const body = (
    <motion.div
      whileHover={{ y: -1 }}
      transition={{ type: "tween", duration: 0.14, ease: "easeOut" }}
      className="group relative flex h-full min-h-[200px] flex-col gap-3.5 rounded-xl border border-border bg-surface p-4 text-left shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-150 ease-out hover:border-border-strong hover:shadow-[var(--shadow-card-hover)]"
    >
      <div className="flex items-center gap-2.5">
        <BrandMark initial={initial} color={color} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold leading-tight text-text-primary">
            {title}
          </div>
          <div className="mt-0.5 font-mono text-[10px] tabular-nums text-text-muted">
            {identifier}
          </div>
        </div>
        {canDelete && (
          <CardMenu
            open={menuOpen}
            confirming={confirming}
            onToggle={handleMenuClick}
            onConfirmDelete={handleDelete}
            onCancelDelete={handleCancelDelete}
          />
        )}
      </div>

      <p className="flex-1 text-[12.5px] leading-relaxed text-text-secondary line-clamp-2">
        {description}
      </p>

      {deleteError && (
        <div
          role="alert"
          className="rounded-md border border-danger/20 bg-danger/10 px-2 py-1 font-mono text-[10px] text-danger"
        >
          {deleteError}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center text-[11px] text-text-muted">
          <span className="flex-1">
            <span className="font-mono tabular-nums text-text-primary">
              {percent}%
            </span>
            <span className="ml-1">complete</span>
          </span>
          <span className="font-mono tabular-nums text-text-faint">
            {taskStats.done}/{activeTotal}
          </span>
        </div>
        <LifecycleBar stats={taskStats} totalActive={activeTotal} />
      </div>

      <div className="flex items-center gap-2 border-t border-border/60 pt-2.5">
        <StatusPill status={status} />
        <span className="flex-1" />
        {team ? <TeamChip team={team} size="xs" /> : null}
        <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-text-muted">
          {lastActive}
        </span>
      </div>
    </motion.div>
  );

  if (opensWorkspace || !isCliManagedStatus(status)) {
    return (
      <Link href={`/project/${id}`} className="block h-full no-underline">
        {body}
      </Link>
    );
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        className="block h-full cursor-pointer no-underline"
      >
        {body}
      </div>
      <ProjectStatusModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        status={status}
        title={title}
        identifier={identifier}
      />
    </>
  );
}

interface BrandMarkProps {
  /** Single uppercase glyph rendered inside the mark. */
  initial: string;
  /** CSS colour string from {@link projectColor} (currently `hsl(...)`). */
  color: string;
}

/**
 * 28×28 rounded square with a mono first-letter glyph on a per-project
 * gradient. Mirrors the prototype's project brand mark.
 *
 * @param props - Initial and hex base colour.
 * @returns Square chip suitable for inline use in card headers.
 */
function BrandMark({ initial, color }: BrandMarkProps) {
  const background = `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 50%, var(--color-accent-2)))`;
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] font-mono text-[12px] font-bold"
      style={{ background, color: "rgba(0, 0, 0, 0.7)" }}
    >
      {initial}
    </span>
  );
}

interface LifecycleBarProps {
  /** Per-status task counts for the project. */
  stats: ProjectTaskStats;
  /** Active-task denominator (`total - cancelled`) for segment widths. */
  totalActive: number;
}

/**
 * Status bands rendered draft → done left → right, so completed work fills
 * toward the right edge. Each band draws in its canonical `--color-glyph-*`
 * status colour, matching the graph and {@link StatusGlyph} convention.
 * `cancelled` is excluded — it is removed from the denominator, not shown
 * as progress.
 */
const LIFECYCLE_BANDS = [
  { key: "draft", color: "var(--color-glyph-draft)" },
  { key: "planned", color: "var(--color-glyph-planned)" },
  { key: "inProgress", color: "var(--color-glyph-progress)" },
  { key: "inReview", color: "var(--color-glyph-review)" },
  { key: "done", color: "var(--color-glyph-done)" },
] as const satisfies ReadonlyArray<{
  key: keyof ProjectTaskStats;
  color: string;
}>;

/**
 * Slim 5px lifecycle bar with one coloured band per task status, filling
 * draft → done so completed work reads at the right edge.
 *
 * @param props - Per-status counts plus the active-task denominator.
 * @returns Segmented bar with 2px gaps and rounded ends.
 */
function LifecycleBar({ stats, totalActive }: LifecycleBarProps) {
  if (totalActive === 0) {
    return (
      <div
        aria-hidden="true"
        className="h-[5px] rounded-full border border-dashed border-border-strong/50"
      />
    );
  }
  return (
    <div className="flex h-[5px] gap-[2px] overflow-hidden rounded-full bg-border/70">
      {LIFECYCLE_BANDS.map(({ key, color }) => {
        const count = stats[key];
        if (count <= 0) return null;
        return (
          <span
            key={key}
            aria-hidden="true"
            className="rounded-sm"
            style={{
              width: `${(count / totalActive) * 100}%`,
              background: color,
            }}
          />
        );
      })}
    </div>
  );
}

interface StatusPillProps {
  /** Raw project lifecycle status. */
  status: string;
}

/**
 * Footer status pill with a coloured dot and humanised label.
 *
 * @param props - Status string from {@link ProjectListEntry}.
 * @returns Pill element styled by status family.
 */
function StatusPill({ status }: StatusPillProps) {
  const tone = pillTone(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${tone.bg} ${tone.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {pillLabel(status)}
    </span>
  );
}

/**
 * Tailwind class set per status so the pill colour reads correctly without
 * dropping into arbitrary values.
 *
 * @param status - Project lifecycle status.
 * @returns Background, text, and dot Tailwind classes.
 */
function pillTone(status: string): { bg: string; text: string; dot: string } {
  if (status === "active")
    return { bg: "bg-done/15", text: "text-done", dot: "bg-done" };
  if (status === "decomposing")
    return { bg: "bg-progress/15", text: "text-progress", dot: "bg-progress" };
  if (status === "brainstorming")
    return { bg: "bg-accent/15", text: "text-accent-light", dot: "bg-accent" };
  return { bg: "bg-draft/10", text: "text-draft", dot: "bg-draft" };
}

/**
 * Humanise the status string for the pill.
 *
 * @param status - Project lifecycle status.
 * @returns Display label.
 */
function pillLabel(status: string): string {
  if (status === "brainstorming") return "Idea";
  if (status === "decomposing") return "Building";
  if (status === "active") return "Active";
  return status;
}

interface CardMenuProps {
  /** True when the popover is rendered. */
  open: boolean;
  /** True when the user is in the two-step delete confirm. */
  confirming: boolean;
  /** Toggle the popover open state. */
  onToggle: (e: React.MouseEvent) => void;
  /** Arm/run delete (two-step). */
  onConfirmDelete: (e: React.MouseEvent) => void;
  /** Cancel the armed delete state. */
  onCancelDelete: (e: React.MouseEvent) => void;
}

/**
 * Three-dot overflow menu shown on hover. Houses the inline delete
 * confirm so the destructive action stays out of the card's click target
 * but is still discoverable.
 *
 * @param props - Open/confirm state and handlers.
 * @returns Trigger button with a small popover.
 */
function CardMenu({
  open,
  confirming,
  onToggle,
  onConfirmDelete,
  onCancelDelete,
}: CardMenuProps) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Project actions"
        title="Project actions"
        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:bg-surface-hover hover:text-text-primary group-hover:opacity-100 data-[open=true]:opacity-100"
        data-open={open || confirming}
      >
        <IconMore size={14} />
      </button>
      {(open || confirming) && (
        <div
          role="menu"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="absolute right-0 top-7 z-20 min-w-[140px] rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow-float)]"
        >
          {confirming ? (
            <div className="flex flex-col gap-1 p-1">
              <p className="px-1 pb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                Delete project?
              </p>
              <button
                type="button"
                onClick={onConfirmDelete}
                className="cursor-pointer rounded-md bg-danger/10 px-2 py-1 text-left text-[11px] font-semibold text-danger transition-colors hover:bg-danger/20"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                className="cursor-pointer rounded-md px-2 py-1 text-left text-[11px] text-text-secondary transition-colors hover:bg-surface-hover"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onConfirmDelete}
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <IconTrash size={12} />
              Delete project
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default ProjectCard;
