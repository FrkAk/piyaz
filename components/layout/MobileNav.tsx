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
import {
  SidebarPanel,
  type SidebarTeam,
  type SidebarUser,
} from "@/components/layout/Sidebar";
import { useCommandPalette } from "@/components/layout/CommandPaletteProvider";
import { Drawer } from "@/components/shared/Drawer";
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
  /** Teams the caller is a member of, ordered by membership creation. */
  teams: SidebarTeam[];
}

/**
 * Left slide-in navigation drawer for viewports below `lg`, where the
 * desktop sidebar is hidden. Reuses {@link SidebarPanel} with a close
 * button in place of the collapse toggle. Closes on backdrop click, Esc,
 * route change, and before opening the command palette. Dialog chrome
 * (Escape via the shared modal stack, Tab focus trap, focus seed and
 * restore) comes from {@link useModalChrome}.
 *
 * @param props - Sidebar data threaded from AppShell.
 * @returns Backdrop + sliding panel, rendered only below `lg`.
 */
export function MobileNavDrawer({
  user,
  workspaceLabel,
  teams,
}: MobileNavDrawerProps) {
  const { open, closeNav } = useMobileNav();
  const { openPalette } = useCommandPalette();
  const pathname = usePathname();

  useEffect(() => {
    closeNav();
  }, [pathname, closeNav]);

  /** Close the drawer first so the palette isn't stacked over it. */
  const handleOpenPalette = useCallback(() => {
    closeNav();
    openPalette();
  }, [closeNav, openPalette]);

  return (
    <Drawer
      open={open}
      onClose={closeNav}
      side="left"
      width="var(--sidebar-w)"
      label="Navigation"
      modal
      fullHeight
      wrapperClassName="lg:hidden"
      panelClassName="bg-[var(--color-base-2)]"
    >
      <SidebarPanel
        user={user}
        workspaceLabel={workspaceLabel}
        teams={teams}
        dismissLabel="Close navigation"
        dismissIcon={<IconX size={13} />}
        onDismiss={closeNav}
        onOpenPalette={handleOpenPalette}
      />
    </Drawer>
  );
}

export default MobileNavDrawer;
