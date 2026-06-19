"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** Cookie name for the sidebar collapsed-state preference. Server-readable so SSR can render the correct width on first paint and avoid a hydration flash. */
const COOKIE_NAME = "piyaz-sidebar-collapsed";
/** Cookie max-age in seconds (1 year). */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

interface SidebarCollapseValue {
  /** Whether the sidebar is currently collapsed to its icon-only rail. */
  collapsed: boolean;
  /** Flip the collapsed state. */
  toggle: () => void;
  /** Force the collapsed state. */
  setCollapsed: (next: boolean) => void;
}

const SidebarCollapseContext = createContext<SidebarCollapseValue | null>(null);

const listeners = new Set<() => void>();
let cachedValue: boolean | null = null;

/**
 * Read the persisted value from `document.cookie`. Browser-only.
 *
 * @returns `true` when the cookie marks the sidebar as collapsed.
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
    /* swallow cookie errors — preference is non-critical */
  }
}

/**
 * Subscribe to in-tab collapse-state changes. Updates from other tabs would
 * require a `BroadcastChannel`; cross-tab sync is intentionally out of scope.
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
 * access. Cached so {@link useSyncExternalStore}'s repeated `getSnapshot`
 * calls return a referentially stable value.
 *
 * @returns `true` when the sidebar should render collapsed.
 */
function getClientSnapshot(): boolean {
  if (cachedValue !== null) return cachedValue;
  cachedValue = readCookie();
  return cachedValue;
}

/**
 * Persist a new collapse state and broadcast to in-tab subscribers.
 *
 * @param next - The new collapse state.
 */
function persist(next: boolean): void {
  cachedValue = next;
  writeCookie(next);
  listeners.forEach((l) => l());
}

interface SidebarCollapseProviderProps {
  /** Initial collapse state read from the cookie on the server. */
  initialCollapsed: boolean;
  /** @param children - Subtree that can read/update the collapsed state. */
  children: ReactNode;
}

/**
 * Client provider exposing the sidebar collapse toggle to any descendant.
 * Mounted by the (server) {@link AppShell} so the {@link Sidebar} chevron
 * and the in-canvas fold button stay in sync without explicit prop drilling.
 *
 * Uses {@link useSyncExternalStore} with a server snapshot derived from the
 * `piyaz-sidebar-collapsed` cookie — SSR renders the persisted width
 * directly, so refreshing on a collapsed sidebar paints collapsed-first
 * with no flash.
 *
 * @param props - Provider configuration.
 * @returns Context provider element.
 */
export function SidebarCollapseProvider({
  initialCollapsed,
  children,
}: SidebarCollapseProviderProps) {
  const collapsed = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    () => initialCollapsed,
  );

  const toggle = useCallback(() => {
    persist(!getClientSnapshot());
  }, []);
  const setCollapsed = useCallback((next: boolean) => {
    persist(next);
  }, []);

  return (
    <SidebarCollapseContext value={{ collapsed, toggle, setCollapsed }}>
      {children}
    </SidebarCollapseContext>
  );
}

/**
 * Read the current sidebar collapse state. Returns a default expanded state
 * with no-op handlers when the hook is called outside the provider so the
 * Sidebar (and any consumer) can render safely on auth pages without a shell.
 *
 * @returns Collapse state + handlers.
 */
export function useSidebarCollapse(): SidebarCollapseValue {
  const ctx = useContext(SidebarCollapseContext);
  if (ctx) return ctx;
  return { collapsed: false, toggle: () => {}, setCollapsed: () => {} };
}
