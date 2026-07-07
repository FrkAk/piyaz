"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Cookie max-age in seconds (1 year). */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

interface CookieCollapse {
  /** Whether the surface is currently collapsed (hidden). */
  collapsed: boolean;
  /** Flip the collapsed state and persist it. */
  toggle: () => void;
}

/**
 * Build a cookie-persisted collapse hook around one cookie name. Each
 * call owns its module-level store (listener set plus lazily-read cached
 * value), so repeated `getSnapshot` calls stay referentially stable.
 * Server-renders expanded ({@link useSyncExternalStore} server snapshot),
 * then reconciles to the cookie value after hydration.
 *
 * @param cookieName - Cookie persisting the preference.
 * @returns Hook exposing the collapse state and its toggle.
 */
function createCookieCollapse(cookieName: string): () => CookieCollapse {
  const listeners = new Set<() => void>();
  let cachedValue: boolean | null = null;

  /**
   * Read the persisted value from `document.cookie`. Browser-only.
   *
   * @returns `true` when the cookie marks the surface as collapsed.
   */
  function readCookie(): boolean {
    try {
      const match = document.cookie.match(
        new RegExp(`(?:^|; )${cookieName}=([^;]*)`),
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
      document.cookie = `${cookieName}=${next ? "1" : "0"}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
    } catch {
      /* swallow cookie errors; preference is non-critical */
    }
  }

  /**
   * Subscribe to in-tab collapse changes.
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
   * Read the cached collapse state, lazily loading from the cookie on
   * first access.
   *
   * @returns `true` when the surface should render collapsed.
   */
  function getClientSnapshot(): boolean {
    if (cachedValue !== null) return cachedValue;
    cachedValue = readCookie();
    return cachedValue;
  }

  return function useCookieCollapse(): CookieCollapse {
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
  };
}

/** Cookie-persisted toggle for hiding the notes tree rail at `lg` and up. */
export const useNotesRailCollapse = createCookieCollapse(
  "piyaz-notes-rail-collapsed",
);

/** Cookie-persisted toggle for hiding the notes settings ribbon at `xl` and up. */
export const useNotesSettingsCollapse = createCookieCollapse(
  "piyaz-notes-settings-collapsed",
);
