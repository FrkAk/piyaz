import type { Priority } from "@/lib/types";

/**
 * Display order for every priority surface — highest urgency first. The
 * PriorityDropdown options, the FilterPanel chip row, and the StructureView
 * sort comparator all read from this single list so they cannot drift.
 */
export const PRIORITY_DISPLAY_ORDER: readonly Priority[] = [
  "urgent",
  "core",
  "normal",
  "backlog",
];

/**
 * Sort rank for the `?sort=priority` comparator. `urgent` is zero so it
 * sorts first; tasks without a priority pass through a sentinel `4` at the
 * call site so they trail the lowest assigned value.
 */
export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  core: 1,
  normal: 2,
  backlog: 3,
};

/**
 * Rank assigned to tasks with `priority === null` — one beyond the lowest
 * assigned value so unset rows sort below `backlog` instead of above
 * `urgent`.
 */
export const PRIORITY_RANK_UNSET = 4;

/**
 * URL/chip sentinel matching the `priority === null` bucket in the filter
 * panel. Keeps the four schema priorities plus this single sentinel as a
 * closed five-value set.
 */
export const UNPRIORITIZED_KEY = "Unprioritized";

/**
 * Color tokens by priority — drives every priority pill/chip tint
 * (PropRail trigger, future row pills, future filter chip glow). Reading
 * from this map keeps surfaces in lockstep when the palette retunes.
 */
export const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: "var(--color-danger)",
  core: "var(--color-glyph-progress)",
  normal: "var(--color-accent)",
  backlog: "var(--color-text-muted)",
};
