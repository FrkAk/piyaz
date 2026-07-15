"use client";

import { useTheme } from "@/components/layout/ThemeProvider";
import { IconMoon, IconSun } from "@/components/shared/icons";

/**
 * Theme switcher for the auth surface — the TopBar toggle restyled as a
 * floating action pinned to the top-right corner of the page.
 *
 * @returns Icon button that flips and persists the light/dark theme.
 */
export function AuthThemeToggle() {
  const { theme, setTheme } = useTheme();
  const label =
    theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label={label}
      title={label}
      className="absolute right-4 top-4 z-20 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-[var(--color-border)] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
      style={{ background: "var(--color-base-2)" }}
    >
      {theme === "dark" ? <IconMoon size={14} /> : <IconSun size={14} />}
    </button>
  );
}
