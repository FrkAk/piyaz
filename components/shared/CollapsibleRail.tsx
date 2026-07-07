"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

interface CollapsibleRailProps {
  /** Whether the rail is expanded. */
  open: boolean;
  /** Expanded width in pixels. */
  width: number;
  /** Rail body — held at a fixed width so it never reflows while collapsing. */
  children: ReactNode;
}

/**
 * Inline collapsible rail that animates its width instead of popping in and
 * out. The body mounts on expand and unmounts after the collapse animation
 * (via `AnimatePresence` exit), so a hidden rail costs nothing — matching the
 * plain conditional-mount it replaces. Reduced motion comes from the global
 * `MotionConfig`.
 *
 * @param props - Rail state, expanded width, and body.
 * @returns The animated rail, or nothing while collapsed.
 */
export function CollapsibleRail({
  open,
  width,
  children,
}: CollapsibleRailProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="flex flex-col overflow-hidden"
          initial={{ width: 0 }}
          animate={{ width }}
          exit={{ width: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          style={{ flexShrink: 0, minWidth: 0 }}
        >
          <div className="flex h-full flex-col" style={{ width }}>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default CollapsibleRail;
