'use client';

import { type CSSProperties, type RefObject, useCallback, useEffect, useState } from 'react';

/**
 * `position: fixed` coordinates for a portalled popover, keyed to one
 * vertical edge of the trigger (`below` → top, `above` → bottom) and one
 * horizontal edge (`start` → left, `end` → right). `width` carries the
 * trigger's measured width so callers can opt into match-trigger-width.
 */
export type PopoverAnchor =
  | { vertical: 'below'; horizontal: 'start'; top: number; left: number; width: number }
  | { vertical: 'below'; horizontal: 'end'; top: number; right: number; width: number }
  | { vertical: 'above'; horizontal: 'start'; bottom: number; left: number; width: number }
  | { vertical: 'above'; horizontal: 'end'; bottom: number; right: number; width: number };

/**
 * Measure the trigger and decide where the panel should attach. Flips
 * above the trigger when there is not enough room below and there is
 * more room above; otherwise stays below and lets the panel's internal
 * scroll handle overflow.
 *
 * @param rect - Trigger client rect.
 * @param align - Caller-requested horizontal anchor edge.
 * @param popoverHeight - Worst-case panel height; drives the flip decision.
 * @returns Discriminated anchor descriptor.
 */
function computeAnchor(
  rect: DOMRect,
  align: 'start' | 'end',
  popoverHeight: number,
): PopoverAnchor {
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const flip = spaceBelow < popoverHeight && spaceAbove > spaceBelow;
  if (flip) {
    if (align === 'end') {
      return {
        vertical: 'above',
        horizontal: 'end',
        bottom: window.innerHeight - rect.top + 4,
        right: window.innerWidth - rect.right,
        width: rect.width,
      };
    }
    return {
      vertical: 'above',
      horizontal: 'start',
      bottom: window.innerHeight - rect.top + 4,
      left: rect.left,
      width: rect.width,
    };
  }
  if (align === 'end') {
    return {
      vertical: 'below',
      horizontal: 'end',
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      width: rect.width,
    };
  }
  return {
    vertical: 'below',
    horizontal: 'start',
    top: rect.bottom + 4,
    left: rect.left,
    width: rect.width,
  };
}

/** Options for {@link usePopoverAnchor}. */
interface UsePopoverAnchorOptions {
  /** Whether the popover is currently open. Listeners attach only while true. */
  open: boolean;
  /** Ref to the trigger element whose rect drives the anchor. */
  triggerRef: RefObject<HTMLElement | null>;
  /** Horizontal anchor edge of the panel relative to the trigger. */
  align: 'start' | 'end';
  /** Worst-case popover height in pixels; drives the flip-above decision. */
  popoverHeight: number;
}

/** Return value of {@link usePopoverAnchor}. */
interface UsePopoverAnchorResult {
  /** Latest anchor; null until the first measurement completes. */
  anchor: PopoverAnchor | null;
  /**
   * Measure the trigger synchronously. Call inside a click handler before
   * toggling `open` to avoid the one-frame gap between commit and the
   * effect-driven measurement.
   */
  measureNow: () => void;
}

/**
 * Measure a popover trigger and keep its anchor in sync as the page
 * scrolls or resizes. Updates are coalesced through
 * `requestAnimationFrame` so capture-phase scroll spam from nested
 * scrollers cannot trigger a layout-read and React render per event.
 *
 * @param options - See {@link UsePopoverAnchorOptions}.
 * @returns The latest anchor plus a synchronous {@link UsePopoverAnchorResult.measureNow} escape hatch.
 */
export function usePopoverAnchor({
  open,
  triggerRef,
  align,
  popoverHeight,
}: UsePopoverAnchorOptions): UsePopoverAnchorResult {
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  const measureNow = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor(computeAnchor(rect, align, popoverHeight));
  }, [align, popoverHeight, triggerRef]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const recompute = () => {
      frame = 0;
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setAnchor(computeAnchor(rect, align, popoverHeight));
    };
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(recompute);
    };
    recompute();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open, align, popoverHeight, triggerRef]);

  return { anchor, measureNow };
}

/**
 * Translate a {@link PopoverAnchor} into a `position: fixed` style object.
 * Always emits one vertical and one horizontal coordinate; width handling
 * is left to the caller.
 *
 * @param anchor - Resolved anchor.
 * @returns Style object suitable for the popover's root element.
 */
export function popoverFixedStyle(anchor: PopoverAnchor): CSSProperties {
  return {
    position: 'fixed',
    ...(anchor.vertical === 'below' ? { top: anchor.top } : { bottom: anchor.bottom }),
    ...(anchor.horizontal === 'start' ? { left: anchor.left } : { right: anchor.right }),
  };
}
