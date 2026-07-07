"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Cookie name for the notes settings-ribbon collapsed-state preference. */
const COOKIE_NAME = "piyaz-notes-settings-collapsed";
/** Cookie max-age in seconds (1 year). */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const listeners = new Set<() => void>();
let cachedValue: boolean | null = null;

/**
 * Read the persisted value from `document.cookie`. Browser-only.
 *
 * @returns `true` when the cookie marks the settings ribbon as collapsed.
 */
function readCookie(): boolean {
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`),
    );
    return match?.[1] === "1";
  } catch {
    return false;
  }
}

/**
 * Write the persisted value to `document.cookie`. Browser-only.
 *
 * @param next - The new collapse state.
 */
function writeCookie(next: boolean): void {
  try {
    document.cookie = `${COOKIE_NAME}=${next ? "1" : "0"}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  } catch {
    /* swallow cookie errors; preference is non-critical */
  }
}

/**
 * Subscribe to in-tab settings-collapse changes.
 *
 * @param onStoreChange - Notification callback from {@link useSyncExternalStore}.
 * @returns Unsubscribe function.
 */
function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * Read the cached collapse state, lazily loading from the cookie on first
 * access so repeated `getSnapshot` calls stay referentially stable.
 *
 * @returns `true` when the settings ribbon should render collapsed.
 */
function getClientSnapshot(): boolean {
  if (cachedValue !== null) return cachedValue;
  cachedValue = readCookie();
  return cachedValue;
}

interface NotesSettingsCollapse {
  /** Whether the settings ribbon is currently collapsed (hidden) at `lg`. */
  collapsed: boolean;
  /** Flip the collapsed state and persist it. */
  toggle: () => void;
}

/**
 * Cookie-persisted toggle for hiding the notes settings ribbon at `lg` and
 * up. Server-renders expanded ({@link useSyncExternalStore} server
 * snapshot), then reconciles to the cookie value after hydration.
 *
 * @returns The collapse state and its toggle.
 */
export function useNotesSettingsCollapse(): NotesSettingsCollapse {
  const collapsed = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    () => false,
  );
  const toggle = useCallback(() => {
    cachedValue = !getClientSnapshot();
    writeCookie(cachedValue);
    listeners.forEach((l) => l());
  }, []);
  return { collapsed, toggle };
}
