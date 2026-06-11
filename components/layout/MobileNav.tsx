"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  SidebarPanel,
  type SidebarProject,
  type SidebarTeam,
  type SidebarUser,
} from "@/components/layout/Sidebar";
import { useCommandPalette } from "@/components/layout/CommandPaletteProvider";
import { IconX } from "@/components/shared/icons";

interface MobileNavValue {
  /** Whether the mobile nav drawer is currently open. */
  open: boolean;
  /** Open the drawer. */
  openNav: () => void;
  /** Close the drawer. */
  closeNav: () => void;
}

const MobileNavContext = createContext<MobileNavValue | null>(null);

interface MobileNavProviderProps {
  /** @param children - Subtree that can open/close the mobile nav drawer. */
  children: ReactNode;
}

/**
 * Client provider owning the mobile nav drawer open state. Mounted by the
 * (server) AppShell so the TopBar hamburger and the drawer itself stay in
 * sync without prop drilling.
 *
 * @param props - Provider configuration.
 * @returns Context provider element.
 */
export function MobileNavProvider({ children }: MobileNavProviderProps) {
  const [open, setOpen] = useState(false);
  const openNav = useCallback(() => setOpen(true), []);
  const closeNav = useCallback(() => setOpen(false), []);

  return (
    <MobileNavContext value={{ open, openNav, closeNav }}>
      {children}
    </MobileNavContext>
  );
}

/**
 * Read the mobile nav drawer state. Returns a closed state with no-op
 * handlers outside the provider so TopBar renders safely on pages without
 * an AppShell.
 *
 * @returns Drawer state + handlers.
 */
export function useMobileNav(): MobileNavValue {
  const ctx = useContext(MobileNavContext);
  if (ctx) return ctx;
  return { open: false, openNav: () => {}, closeNav: () => {} };
}

interface MobileNavDrawerProps {
  /** Current user for the footer avatar + sign out. */
  user: SidebarUser;
  /** Label rendered on the workspace switcher row. */
  workspaceLabel: string;
  /** Projects owned by the user (across teams), pre-sorted newest first. */
  projects: SidebarProject[];
  /** Teams the caller is a member of, ordered by membership creation. */
  teams: SidebarTeam[];
}

/**
 * Left slide-in navigation drawer for viewports below `lg`, where the
 * desktop sidebar is hidden. Reuses {@link SidebarPanel} with a close
 * button in place of the collapse toggle. Closes on backdrop click, Esc,
 * route change, and before opening the command palette.
 *
 * @param props - Sidebar data threaded from AppShell.
 * @returns Backdrop + sliding panel, rendered only below `lg`.
 */
export function MobileNavDrawer({
  user,
  workspaceLabel,
  projects,
  teams,
}: MobileNavDrawerProps) {
  const { open, closeNav } = useMobileNav();
  const { openPalette } = useCommandPalette();
  const pathname = usePathname();

  useEffect(() => {
    closeNav();
  }, [pathname, closeNav]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeNav();
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () =>
      document.removeEventListener("keydown", handler, { capture: true });
  }, [open, closeNav]);

  /** Close the drawer first so the palette isn't stacked over it. */
  const handleOpenPalette = useCallback(() => {
    closeNav();
    openPalette();
  }, [closeNav, openPalette]);

  return (
    <AnimatePresence>
      {open && (
        <div className="lg:hidden">
          <motion.div
            key="mobile-nav-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-40 bg-black/45"
            onClick={closeNav}
            aria-hidden="true"
          />
          <motion.aside
            key="mobile-nav-panel"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed left-0 top-0 z-50 flex h-[var(--viewport-height)] w-[var(--sidebar-w)] max-w-[85vw] flex-col border-r border-border shadow-[var(--shadow-float)]"
            style={{ background: "var(--color-base-2)" }}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
          >
            <SidebarPanel
              user={user}
              workspaceLabel={workspaceLabel}
              projects={projects}
              teams={teams}
              dismissLabel="Close navigation"
              dismissIcon={<IconX size={13} />}
              onDismiss={closeNav}
              onOpenPalette={handleOpenPalette}
            />
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

export default MobileNavDrawer;
