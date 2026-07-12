"use client";

import { useEffect, useRef } from "react";
import type React from "react";

/** CSS selector matching tabbable descendants inside the dialog panel. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep keyboard focus inside the dialog panel while Tab is pressed.
 * @param event - The Tab keydown event.
 * @param panel - The panel element scoping focusable descendants.
 * @returns Nothing.
 */
function trapTabFocus(event: KeyboardEvent, panel: HTMLElement | null): void {
  if (!panel) return;
  const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Active modal handle tracked by the global stack — capturing onClose
 * and panel bounds so the topmost dialog can handle Escape and trap Tab
 * focus, even when modals are nested.
 */
interface ModalHandle {
  panelRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const modalStack: ModalHandle[] = [];
let globalListenerInstalled = false;
let lockedBodyOverflow: string | null = null;

/**
 * Lock background scrolling while any modal is open. Applies when the
 * first handle pushes onto the stack and restores the body's previous
 * overflow when the last one pops, so nested modals share one lock.
 */
function syncScrollLock(): void {
  if (modalStack.length > 0 && lockedBodyOverflow === null) {
    lockedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return;
  }
  if (modalStack.length === 0 && lockedBodyOverflow !== null) {
    document.body.style.overflow = lockedBodyOverflow;
    lockedBodyOverflow = null;
  }
}

/**
 * Whether any dialog wired through {@link useModalChrome} is currently
 * open. Page-level Escape handlers (e.g. the detail header's
 * deselect-task listener) call this to yield to the open dialog instead
 * of racing it on listener registration order.
 *
 * @returns `true` while at least one modal is on the stack.
 */
export function isModalOpen(): boolean {
  return modalStack.length > 0;
}

/**
 * Install the single document-level keydown listener responsible for
 * dispatching to the topmost active modal. Idempotent — installs once
 * and stays registered for the lifetime of the page so subsequent
 * modal mounts only push/pop the stack.
 */
function ensureGlobalListenerInstalled(): void {
  if (globalListenerInstalled) return;
  globalListenerInstalled = true;
  document.addEventListener("keydown", (e) => {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      top.onClose();
      return;
    }
    if (e.key === "Tab") {
      trapTabFocus(e, top.panelRef.current);
    }
  });
}

/**
 * Wires modal chrome behavior: Escape to close, Tab focus trap, focus
 * restore on unmount, and a background scroll lock while open — the
 * behavior `aria-modal` promises. Stack-aware so nested modals (e.g. a
 * destructive confirm dialog opened from inside a settings modal) are
 * each handled by the topmost dialog only — outer modals stay open
 * until the inner one dismisses.
 *
 * @param open - Whether the modal is currently open.
 * @param onClose - Callback invoked when Escape pops this modal off
 *   the stack. Closure identity may change across renders; the hook
 *   always dispatches the latest `onClose`.
 * @param panelRef - Ref to the modal panel — used to bound the focus
 *   trap and to seed initial focus.
 */
export function useModalChrome(
  open: boolean,
  onClose: () => void,
  panelRef: React.RefObject<HTMLElement | null>,
): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    ensureGlobalListenerInstalled();
    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const handle: ModalHandle = {
      panelRef,
      onClose: () => onCloseRef.current(),
    };
    modalStack.push(handle);
    syncScrollLock();

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelector<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      const idx = modalStack.indexOf(handle);
      if (idx !== -1) modalStack.splice(idx, 1);
      syncScrollLock();
      previousFocusRef.current?.focus?.();
    };
  }, [open, panelRef]);
}
