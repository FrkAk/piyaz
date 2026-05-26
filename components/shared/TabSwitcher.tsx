"use client";

import { motion } from "motion/react";
import { useRef, useCallback } from "react";

interface Tab {
  id: string;
  label: string;
  /** Optional count rendered as a small mono chip next to the label. */
  count?: number;
  /** Decorative pulse dot on the tab corner (e.g. a tab with new activity). */
  glow?: boolean;
}

interface TabSwitcherProps {
  /** @param tabs - Array of tab definitions. */
  tabs: Tab[];
  /** @param activeTab - Currently active tab id. */
  activeTab: string;
  /** @param onTabChange - Called when a tab is selected. */
  onTabChange: (id: string) => void;
  /** @param trailing - Optional element rendered at the end of the tab bar. */
  trailing?: React.ReactNode;
  /** @param stretch - When true, tabs expand equally to fill available width. */
  stretch?: boolean;
  /** @param className - Additional CSS classes. */
  className?: string;
}

/**
 * Horizontal pill segmented tab control with an animated sliding indicator.
 *
 * Designed to match the prototype's segmented buttons; pairs `surface-raised` with the
 * accent gradient on the active tab indicator. Use {@link import('./ViewTabs').ViewTabs}
 * when a sub-page navigation with an underline is desired instead.
 *
 * @param props - Tab switcher configuration.
 * @returns A styled tab switcher element.
 */
export function TabSwitcher({
  tabs,
  activeTab,
  onTabChange,
  trailing,
  stretch,
  className = "",
}: TabSwitcherProps) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const idx = tabs.findIndex((t) => t.id === activeTab);
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        next = (idx + 1) % tabs.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        next = (idx - 1 + tabs.length) % tabs.length;
      }
      if (next >= 0) {
        onTabChange(tabs[next].id);
        tabRefs.current.get(tabs[next].id)?.focus();
      }
    },
    [tabs, activeTab, onTabChange],
  );

  return (
    <div
      role="tablist"
      aria-label="Tab navigation"
      className={`${stretch ? "flex w-full" : "inline-flex"} items-center gap-0.5 rounded-md p-0.5 ${className}`}
      style={{
        background:
          "color-mix(in srgb, var(--color-surface-raised) 70%, transparent)",
        border: "1px solid var(--color-border)",
      }}
    >
      {tabs.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el);
              else tabRefs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={handleKeyDown}
            className={`relative cursor-pointer rounded-md px-3 transition-colors ${stretch ? "flex-1" : ""}`}
            style={{
              height: 24,
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              color: active
                ? "var(--color-text-primary)"
                : "var(--color-text-muted)",
              letterSpacing: "0.005em",
            }}
          >
            {active ? (
              <motion.span
                layoutId="tab-indicator"
                aria-hidden="true"
                className="absolute inset-0 rounded-md"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border-strong)",
                  boxShadow: "var(--shadow-button)",
                  zIndex: 0,
                }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
              />
            ) : null}
            <span className="relative z-[1] inline-flex items-center gap-1.5">
              <span className="whitespace-nowrap">{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  className="inline-flex items-center rounded px-1.5 py-px font-mono text-[10px] tabular-nums"
                  style={{
                    background: active
                      ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                      : "color-mix(in srgb, var(--color-surface) 70%, transparent)",
                    color: active
                      ? "var(--color-accent-light)"
                      : "var(--color-text-faint)",
                  }}
                >
                  {tab.count}
                </span>
              )}
            </span>
            {tab.glow && !active ? (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 status-pulse"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--color-accent)",
                }}
              />
            ) : null}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}

export default TabSwitcher;
