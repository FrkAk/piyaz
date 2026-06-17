"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** Cookie name for the graph-rail collapsed-state preference. Server-readable so SSR can render the correct width on first paint and avoid a hydration flash. */
const COOKIE_NAME = "mymir-graph-rail-collapsed";
/** Cookie max-age in seconds (1 year). */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

interface GraphRailCollapseValue {
  /** Whether the graph rail is currently collapsed to its icon-only strip. */
  collapsed: boolean;
  /** Flip the collapsed state. */
  toggle: () => void;
}

const GraphRailCollapseContext = createContext<GraphRailCollapseValue | null>(
  null,
);

const listeners = new Set<() => void>();
let cachedValue: boolean | null = null;

/**
 * Read the persisted value from `document.cookie`. Browser-only.
 *
 * @returns `true` when the cookie marks the graph rail as collapsed.
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
 * Subscribe to in-tab graph-rail-collapse changes. Cross-tab sync is
 * intentionally out of scope.
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
 * @returns `true` when the graph rail should render collapsed.
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

interface GraphRailCollapseProviderProps {
  /** Initial collapse state read from the cookie on the server. */
  initialCollapsed: boolean;
  /** @param children - Subtree that can read/update the collapsed state. */
  children: ReactNode;
}

/**
 * Client provider exposing the graph-rail collapse toggle. Mounted by the
 * (server) workspace page so the {@link MiniTaskRail} chevron stays in sync
 * with the cookie, and so SSR paints the persisted width directly without
 * a hydration flash.
 *
 * @param props - Provider configuration.
 * @returns Context provider element.
 */
export function GraphRailCollapseProvider({
  initialCollapsed,
  children,
}: GraphRailCollapseProviderProps) {
  const collapsed = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    () => initialCollapsed,
  );

  const toggle = useCallback(() => {
    persist(!getClientSnapshot());
  }, []);

  return (
    <GraphRailCollapseContext value={{ collapsed, toggle }}>
      {children}
    </GraphRailCollapseContext>
  );
}

/**
 * Read the current graph-rail collapse state.
 *
 * Throws in development when called outside {@link GraphRailCollapseProvider}
 * — the provider is mounted at the workspace page root so any consumer
 * outside it is misuse, and silent failure would leave the chevron toggle
 * inert with no signal. In production the hook returns a default expanded
 * state so a misconfigured deploy doesn't crash the workspace.
 *
 * @returns Collapse state + toggle.
 * @throws Error in non-production builds when called outside the provider.
 */
export function useGraphRailCollapse(): GraphRailCollapseValue {
  const ctx = useContext(GraphRailCollapseContext);
  if (ctx) return ctx;
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      "useGraphRailCollapse must be used within <GraphRailCollapseProvider>",
    );
  }
  return { collapsed: false, toggle: () => {} };
}
