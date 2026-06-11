"use client";

import { TabSwitcher } from "@/components/shared/TabSwitcher";
import { SAVED_VIEWS, SAVED_VIEW_LABEL, type SavedView } from "./predicates";

interface SavedViewsTabsProps {
  value: SavedView;
  counts: Record<SavedView, number>;
  onChange: (next: SavedView) => void;
}

export function SavedViewsTabs({
  value,
  counts,
  onChange,
}: SavedViewsTabsProps) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
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
