"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Debounced skeleton visibility for perceived-performance alignment.
 *
 * Translates a raw loading flag into "should a skeleton render" using two
 * thresholds:
 *
 * - Show delay: loading that resolves within `showDelayMs` never surfaces
 *   a skeleton, so fast fetches swap straight to content instead of
 *   flashing placeholder chrome for a few frames.
 * - Minimum visible time: once shown, the skeleton stays for at least
 *   `minVisibleMs` so it cannot flash-swap away mid-entrance when content
 *   lands just after the delay threshold.
 *
 * @param loading - Raw loading flag (e.g. `isPlaceholderData`).
 * @param showDelayMs - Delay before the skeleton may appear.
 * @param minVisibleMs - Minimum time the skeleton stays visible once shown.
 * @returns True while the skeleton should render.
 */
export function useSkeletonVisibility(
  loading: boolean,
  showDelayMs = 200,
  minVisibleMs = 400,
): boolean {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef(0);

  useEffect(() => {
    if (loading && !visible) {
      const timer = setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, showDelayMs);
      return () => clearTimeout(timer);
    }
    if (!loading && visible) {
      const remaining = Math.max(
        0,
        minVisibleMs - (Date.now() - shownAtRef.current),
      );
      if (remaining === 0) {
        setVisible(false);
        return;
      }
      const timer = setTimeout(() => setVisible(false), remaining);
      return () => clearTimeout(timer);
    }
  }, [loading, visible, showDelayMs, minVisibleMs]);

  return visible;
}
