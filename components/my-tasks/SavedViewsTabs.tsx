"use client";

import { TabSwitcher } from "@/components/shared/TabSwitcher";
import { SAVED_VIEWS, SAVED_VIEW_LABEL, type SavedView } from "./predicates";

interface SavedViewsTabsProps {
  /** Currently-active view. */
  value: SavedView;
  /** Counts per view, derived from the full payload. */
  counts: Record<SavedView, number>;
  /** Switch the active view. */
  onChange: (next: SavedView) => void;
}

/**
 * Saved-view segmented control on `/my-tasks`. Five fixed presets (open /
 * today / stale / done / all). Renders through the shared `TabSwitcher` so
 * the sliding indicator, arrow-key navigation, and pill styling stay in
 * lockstep with every other segmented surface (onboarding, primitives,
 * future agent feed). The wrapper adds a horizontal-scroll bleed below `sm`
 * so the strip can swipe-scroll within the page padding without horizontal
 * page overflow.
 *
 * @param props - Active view + counts + onChange.
 * @returns Mobile-scrolling segmented control row.
 */
export function SavedViewsTabs({
  value,
  counts,
  onChange,
}: SavedViewsTabsProps) {
  return (
    <div className="-mx-8 overflow-x-auto px-8 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <TabSwitcher
        activeTab={value}
        onTabChange={(id) => onChange(id as SavedView)}
        tabs={SAVED_VIEWS.map((view) => ({
          id: view,
          label: SAVED_VIEW_LABEL[view],
          count: counts[view],
        }))}
      />
    </div>
  );
}
