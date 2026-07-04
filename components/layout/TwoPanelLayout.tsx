"use client";

import { type ReactNode, useState } from "react";

interface TwoPanelLayoutProps {
  /** @param left - Content for the left panel. */
  left: ReactNode;
  /** @param right - Content for the right panel. */
  right: ReactNode;
  /** @param className - Additional CSS classes. */
  className?: string;
  /** @param activePanelHint - When changed, auto-switches to this panel on mobile. */
  activePanelHint?: "left" | "right";
}

/**
 * Split two-panel layout filling its parent.
 * Above lg breakpoint: side-by-side with left (40%) and right (60%).
 * Below lg: toggle bar with "Navigator" / "Details" tabs showing one panel at a time.
 * @param props - Panel content, optional className, and optional activePanelHint.
 * @returns The two-panel layout component.
 */
export function TwoPanelLayout({
  left,
  right,
  className = "",
  activePanelHint,
}: TwoPanelLayoutProps) {
  const [activePanel, setActivePanel] = useState<"left" | "right">(
    activePanelHint ?? "left",
  );
  const [prevHint, setPrevHint] = useState(activePanelHint);

  if (activePanelHint !== prevHint) {
    setPrevHint(activePanelHint);
    if (activePanelHint) {
      setActivePanel(activePanelHint);
    }
  }

  return (
    <div className={`h-full ${className}`}>
      {/* Desktop: side-by-side */}
      <div className="hidden lg:flex h-full">
        <div data-panel="navigator" className="w-2/5 min-h-0 overflow-y-auto">
          {left}
        </div>
        <div className="w-px bg-gradient-to-b from-border-strong via-border to-transparent" />
        <div
          data-panel="detail"
          className="w-3/5 overflow-hidden flex flex-col min-h-0"
        >
          {right}
        </div>
      </div>

      {/* Mobile: toggle bar + single panel */}
      <div className="flex flex-col h-full lg:hidden">
        <div className="flex border-b border-border bg-surface shrink-0">
          <ToggleTab
            label="Navigator"
            active={activePanel === "left"}
            onClick={() => setActivePanel("left")}
          />
          <ToggleTab
            label="Details"
            active={activePanel === "right"}
            onClick={() => setActivePanel("right")}
          />
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {activePanel === "left" ? left : right}
        </div>
      </div>
    </div>
  );
}

/**
 * A single tab button for the mobile toggle bar.
 * @param props - Label text, active state, and click handler.
 * @returns A styled button element.
 */
function ToggleTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-2.5 text-xs sm:text-sm font-medium transition-opacity ${
        active
          ? "text-text-primary border-b-2 border-accent"
          : "text-text-muted hover:opacity-60"
      }`}
    >
      {label}
    </button>
  );
}

export default TwoPanelLayout;
