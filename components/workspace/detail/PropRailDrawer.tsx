"use client";

import { Drawer } from "@/components/shared/Drawer";
import { IconX } from "@/components/shared/icons";

interface PropRailDrawerProps {
  /** Whether the drawer is open. */
  open: boolean;
  /** Close the drawer. */
  onClose: () => void;
  /** Drawer body — typically a `<PropRail />`. */
  children: React.ReactNode;
}

/**
 * Slide-out drawer wrapping the property rail for viewports below 1280px,
 * right-anchored with a titlebar. Backdrop, slide, and dialog chrome come
 * from the shared {@link Drawer}; the detail-header Esc yields to the modal
 * stack, so drawer-Escape never deselects the task behind it.
 *
 * @param props - Drawer configuration.
 * @returns The property-rail drawer.
 */
export function PropRailDrawer({
  open,
  onClose,
  children,
}: PropRailDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      width="var(--rail-w)"
      label="Task properties"
      panelClassName="bg-base"
    >
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Properties
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close properties"
          className="cursor-pointer rounded p-1 text-text-muted hover:bg-surface-hover hover:text-text-secondary"
        >
          <IconX size={11} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </Drawer>
  );
}

export default PropRailDrawer;
