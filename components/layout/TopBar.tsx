"use client";

import { usePathname } from "next/navigation";
import { useTheme } from "@/components/layout/ThemeProvider";
import { ProjectBreadcrumb } from "@/components/layout/ProjectBreadcrumb";
import { useCommandPalette } from "@/components/layout/CommandPaletteProvider";
import { useMobileNav } from "@/components/layout/MobileNav";
import { Kbd } from "@/components/shared/Kbd";
import {
  IconMenu,
  IconMoon,
  IconSearch,
  IconSun,
} from "@/components/shared/icons";

interface TopBarProps {
  /** @param projectName - Optional project crumb label. When set, renders the project breadcrumb pill. */
  projectName?: string;
  /** @param projectId - Project UUID. Required alongside `onOpenProjectSettings` for the settings trigger. */
  projectId?: string;
  /** @param projectStatus - Optional project lifecycle status for the inline chip. */
  projectStatus?: string;
  /** @param team - Optional owning team. Forwarded to {@link ProjectBreadcrumb}. */
  team?: { id: string; name: string };
  /** @param onOpenProjectSettings - Called when the project crumb is clicked. */
  onOpenProjectSettings?: () => void;
  /** @param pageLabel - Optional override for the leading non-project crumb (defaults derive from pathname). */
  pageLabel?: string;
}

/**
 * In-flow top bar that sits at the head of the main column inside
 * {@link AppShell}. Renders a hamburger that opens the mobile nav drawer
 * (below `lg` only), the workspace breadcrumb (when available), an optional
 * page or project crumb, and the right-side action cluster (Jump, theme
 * toggle, avatar).
 *
 * @param props - TopBar configuration.
 * @returns Sticky header element styled per the design spec.
 */
export function TopBar({
  projectName,
  projectId,
  projectStatus,
  team,
  onOpenProjectSettings,
  pageLabel,
}: TopBarProps) {
  const { theme, setTheme } = useTheme();
  const { openPalette } = useCommandPalette();
  const { openNav } = useMobileNav();
  const pathname = usePathname() ?? "/";

  const derivedPageLabel = derivePageLabel({
    projectName,
    pageLabel,
    pathname,
  });

  /** Toggle between light and dark theme and persist the choice. */
  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <header
      className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-base/80 px-3 backdrop-blur-md"
      style={{ height: "var(--topbar-h)" }}
    >
      <button
        type="button"
        onClick={openNav}
        aria-label="Open navigation"
        title="Open navigation"
        className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary lg:hidden"
      >
        <IconMenu size={14} />
      </button>
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-1.5"
      >
        {projectName &&
          (projectId && onOpenProjectSettings ? (
            <ProjectBreadcrumb
              projectName={projectName}
              projectStatus={projectStatus}
              team={team}
              onOpenSettings={onOpenProjectSettings}
            />
          ) : (
            <span className="truncate text-[13px] font-semibold text-text-primary">
              {projectName}
            </span>
          ))}
        {!projectName && derivedPageLabel && (
          <span className="truncate text-[13px] font-semibold text-text-primary">
            {derivedPageLabel}
          </span>
        )}
      </nav>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={openPalette}
          aria-label="Search or jump (⌘K)"
          title="Search or jump (⌘K)"
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <IconSearch size={12} />
          <span className="hidden sm:inline">Jump</span>
          <Kbd dim>⌘K</Kbd>
        </button>
        <span
          aria-hidden="true"
          className="mx-1 hidden h-4 w-px bg-border md:inline-block"
        />
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          title={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          {theme === "dark" ? <IconMoon size={14} /> : <IconSun size={14} />}
        </button>
      </div>
    </header>
  );
}

interface DerivePageLabelInput {
  projectName?: string;
  pageLabel?: string;
  pathname: string;
}

/**
 * Choose the trailing crumb when no project crumb is in play.
 * @param input - Project name override, explicit page label, current path.
 * @returns Crumb label or null when nothing should render.
 */
function derivePageLabel({
  projectName,
  pageLabel,
  pathname,
}: DerivePageLabelInput): string | null {
  if (projectName) return null;
  if (pageLabel) return pageLabel;
  if (pathname === "/") return "Projects";
  if (pathname.startsWith("/settings")) return "Settings";
  return null;
}

export default TopBar;
