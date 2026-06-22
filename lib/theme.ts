const COOKIE_NAME = "piyaz-theme";
/** Cookie max-age in seconds (1 year). */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const listeners = new Set<() => void>();

/**
 * Subscribe to theme changes. Compatible with useSyncExternalStore.
 * @param callback - Invoked when the theme changes.
 * @returns Unsubscribe function.
 */
export function subscribeTheme(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Read the current theme from `document.cookie`.
 * @returns "light" or "dark"; defaults to "dark" on SSR or when unset.
 */
export function getTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`),
    );
    return match?.[1] === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Set theme, persist to cookie, apply to DOM, and notify subscribers.
 * @param theme - "light" or "dark".
 */
export function setTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${COOKIE_NAME}=${theme};path=/;max-age=${COOKIE_MAX_AGE};SameSite=Lax`;
  } catch {
    /* swallow cookie errors — preference is non-critical */
  }
  if (theme === "light") {
    document.documentElement.classList.add("light");
  } else {
    document.documentElement.classList.remove("light");
  }
  listeners.forEach((cb) => cb());
}
