"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/shared/Avatar";
import { Kbd } from "@/components/shared/Kbd";
import { projectColor } from "@/lib/ui/project-color";
import { getTeamColor } from "@/lib/ui/team-color";
import { useSidebarCollapse } from "@/components/layout/SidebarCollapseProvider";
import { useCommandPalette } from "@/components/layout/CommandPaletteProvider";
import {
  IconChevronRight,
  IconInbox,
  IconLogOut,
  IconPanelLeft,
  IconSearch,
  IconSettings,
  IconUser,
} from "@/components/shared/icons";

/** Slim user shape the sidebar needs — fed by AppShell from `getSession()`. */
export interface SidebarUser {
  /** User UUID. */
  id: string;
  /** Display name. */
  name: string;
  /** Email address (used for the avatar tooltip when name is empty). */
  email: string;
  /** Optional avatar URL from the OAuth profile. */
  image?: string | null;
}

/** Slim project shape the sidebar needs — fed by AppShell from `listProjectsSlim()`. */
export interface SidebarProject {
  /** Project UUID — used for the active-row highlight + deep link. */
  id: string;
  /** Short identifier (e.g. `MYMR`) — drives the dot color and the right-aligned chip. */
  identifier: string;
  /** Project title shown in the row. */
  title: string;
  /** Owning team UUID — drives the team-divider grouping. */
  organizationId: string;
}

/** Slim team shape the sidebar needs — fed by AppShell from `listUserTeamsAction()`. */
export interface SidebarTeam {
  /** Team UUID. */
  id: string;
  /** Display name shown in the divider header. */
  name: string;
}

interface SidebarProps {
  /** Current user for footer avatar + workspace label fallback. */
  user: SidebarUser;
  /** Label rendered on the workspace switcher row. */
  workspaceLabel: string;
  /** Projects owned by the user (across teams), pre-sorted newest first. */
  projects: SidebarProject[];
  /** Teams the caller is a member of, ordered by membership creation. */
  teams: SidebarTeam[];
}

/**
 * Workspace sidebar — 224px column with workspace switcher, search jump, top
 * level nav, projects list, agent dock, and user footer. Rendered only at
 * `lg+`; below that the main column owns the full width and per-page TopBar
 * provides navigation.
 *
 * @param props - User, workspace label, and project list.
 * @returns Aside element styled per the design spec.
 */
export function Sidebar({
  user,
  workspaceLabel,
  projects,
  teams,
}: SidebarProps) {
  const [openProjects, setOpenProjects] = useState(true);
  const pathname = usePathname() ?? "/";
  const activeProjectId = pathname.match(/^\/project\/([^/]+)/)?.[1];
  const myTasksActive = pathname.startsWith("/my-tasks");
  const { collapsed, toggle } = useSidebarCollapse();
  const { openPalette } = useCommandPalette();

  const projectGroups = useMemo(
    () => groupProjectsByTeam(projects, teams),
    [projects, teams],
  );
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleTeam = useCallback((teamKey: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamKey)) next.delete(teamKey);
      else next.add(teamKey);
      return next;
    });
  }, []);

  return (
    <aside
      className="hidden lg:flex h-[var(--viewport-height)] flex-col border-r border-border"
      style={{
        width: collapsed ? 56 : "var(--sidebar-w)",
        background: "var(--color-base-2)",
        transition: "width 220ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {collapsed ? (
        <CompactSidebar
          user={user}
          workspaceLabel={workspaceLabel}
          projects={projects}
          activeProjectId={activeProjectId}
          settingsActive={pathname.startsWith("/settings")}
          myTasksActive={myTasksActive}
          onExpand={toggle}
          onOpenPalette={openPalette}
        />
      ) : (
        <>
          <div className="mx-2 mt-2 mb-1 flex items-center gap-1">
            <Link
              href="/"
              title={`${workspaceLabel} — workspace home`}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-hover"
            >
              <BrandMark />
              <div className="min-w-0 flex-1 text-[13px] font-semibold leading-tight text-text-primary">
                mymir
              </div>
            </Link>
            <button
              type="button"
              onClick={toggle}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
            >
              <IconPanelLeft size={13} />
            </button>
          </div>

          <div className="px-2 pb-2 pt-1">
            <button
              type="button"
              onClick={openPalette}
              aria-label="Search or jump (⌘K)"
              title="Search or jump (⌘K)"
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[12px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
            >
              <IconSearch size={12} />
              <span className="flex-1 text-left">Search or jump</span>
              <Kbd dim>⌘K</Kbd>
            </button>
          </div>

          <nav className="flex flex-col gap-px px-2">
            <NavItem
              icon={<IconInbox size={12} />}
              label="Inbox"
              disabledHint="Coming soon"
            />
            <NavItem
              icon={<IconUser size={12} />}
              label="My tasks"
              href="/my-tasks"
              active={myTasksActive}
            />
          </nav>

          <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-4">
            <button
              type="button"
              onClick={() => setOpenProjects((v) => !v)}
              className="flex cursor-pointer items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-text-muted transition-colors hover:text-text-secondary"
            >
              <span
                className="inline-flex transition-transform duration-150"
                style={{
                  transform: openProjects ? "rotate(90deg)" : undefined,
                }}
              >
                <IconChevronRight size={10} />
              </span>
              Projects
            </button>
          </div>

          {openProjects && (
            <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">
              {projects.length === 0 ? (
                <p className="px-2 py-1 text-[11px] italic text-text-muted">
                  No projects yet
                </p>
              ) : projectGroups.length === 1 ? (
                projectGroups[0].projects.map((p) => (
                  <ProjectNavItem
                    key={p.id}
                    project={p}
                    color={projectColor(p.identifier)}
                    active={p.id === activeProjectId}
                  />
                ))
              ) : (
                projectGroups.map((group, idx) => {
                  const teamKey = group.team?.id ?? `__no-team__-${idx}`;
                  return (
                    <ProjectTeamGroup
                      key={teamKey}
                      group={group}
                      activeProjectId={activeProjectId}
                      showSpacer={idx > 0}
                      collapsed={collapsedTeams.has(teamKey)}
                      onToggle={() => toggleTeam(teamKey)}
                    />
                  );
                })
              )}
            </div>
          )}

          {!openProjects && <div className="flex-1" />}

          <UserFooter
            user={user}
            settingsActive={pathname.startsWith("/settings")}
          />
        </>
      )}
    </aside>
  );
}

interface CompactSidebarProps {
  /** Current user. */
  user: SidebarUser;
  /** Workspace label (used for the brand mark tooltip). */
  workspaceLabel: string;
  /** Projects to render as colored dots. */
  projects: SidebarProject[];
  /** Currently active project id, if any. */
  activeProjectId: string | undefined;
  /** Whether the settings route is active. */
  settingsActive: boolean;
  /** Whether the `/my-tasks` route is active. */
  myTasksActive: boolean;
  /** Click the chevron-right to expand the sidebar. */
  onExpand: () => void;
  /** Open the global command palette (wired by the parent's hook call). */
  onOpenPalette: () => void;
}

/**
 * 56px icon-only variant of the sidebar — brand mark, expand toggle, the
 * disabled top-level nav as icons, every project as its color dot, and a
 * compact footer (avatar / settings / sign-out) stacked vertically. Tooltip
 * via `title` carries every label that's been hidden so muscle memory still
 * works at narrow viewports.
 *
 * @param props - Compact-mode configuration.
 * @returns Icon-only sidebar contents.
 */
function CompactSidebar({
  user,
  workspaceLabel,
  projects,
  activeProjectId,
  settingsActive,
  myTasksActive,
  onExpand,
  onOpenPalette,
}: CompactSidebarProps) {
  const router = useRouter();
  const displayName = user.name?.trim() || user.email;

  /** Sign out and bounce to the sign-in page. */
  const handleSignOut = async () => {
    await signOut();
    router.replace("/sign-in");
  };

  return (
    <>
      <div className="flex flex-col items-center gap-1 px-2 pt-2 pb-1">
        <Link
          href="/"
          title={`${workspaceLabel} — workspace home`}
          className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-surface-hover"
        >
          <BrandMark />
        </Link>
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <IconPanelLeft size={13} />
        </button>
      </div>

      <nav className="flex flex-col items-center gap-1 px-2 pt-1">
        <CompactNavIcon
          icon={<IconSearch size={14} />}
          label="Search or jump (⌘K)"
          onClick={onOpenPalette}
        />
        <CompactNavIcon
          icon={<IconInbox size={14} />}
          label="Inbox — coming soon"
          disabled
        />
        <CompactNavIcon
          icon={<IconUser size={14} />}
          label="My tasks"
          href="/my-tasks"
          active={myTasksActive}
        />
      </nav>

      <div className="my-2 mx-3 h-px bg-border" />

      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 pb-2">
        {projects.map((p) => {
          const active = p.id === activeProjectId;
          return (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              title={`${p.title} · ${p.identifier}`}
              className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                active ? "bg-surface-hover" : "hover:bg-surface-hover/60"
              }`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-sm"
                  style={{ background: "var(--color-accent-grad)" }}
                />
              )}
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-[2px]"
                style={{ background: projectColor(p.identifier) }}
              />
            </Link>
          );
        })}
      </div>

      <footer className="flex flex-col items-center gap-1 border-t border-border px-2 py-2">
        <span title={displayName} className="inline-flex">
          <Avatar name={displayName} src={user.image ?? undefined} size={22} />
        </span>
        <Link
          href="/settings"
          aria-label="Settings"
          title="Settings"
          className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
            settingsActive
              ? "bg-surface-hover text-text-primary"
              : "text-text-muted hover:bg-surface-hover hover:text-text-secondary"
          }`}
        >
          <IconSettings size={13} />
        </Link>
        <button
          type="button"
          onClick={handleSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <IconLogOut size={13} />
        </button>
      </footer>
    </>
  );
}

interface CompactNavIconProps {
  /** Leading icon. */
  icon: React.ReactNode;
  /** Tooltip text shown on hover. */
  label: string;
  /** When set, the row renders as a `<Link>` to this href instead of a button. */
  href?: string;
  /** Whether the row is the active route — highlights when set. Ignored without `href`. */
  active?: boolean;
  /** Whether the row is rendered disabled. Ignored when `href` is set. */
  disabled?: boolean;
  /** Click handler for live rows that don't navigate (e.g. search opens the palette). */
  onClick?: () => void;
}

/**
 * Small square icon used as a top-level nav row in {@link CompactSidebar}.
 * Renders three modes based on the props:
 * - `href` set → a Next.js `<Link>` with the active-route highlight.
 * - `disabled` true → a non-interactive button with a `coming soon` tooltip.
 * - otherwise → a live `<button>` that calls `onClick` (e.g. search opens the palette).
 *
 * @param props - Icon configuration.
 * @returns Icon-shaped link or button.
 */
function CompactNavIcon({
  icon,
  label,
  href,
  active,
  disabled,
  onClick,
}: CompactNavIconProps) {
  const className = `inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
    disabled
      ? "cursor-not-allowed text-text-muted opacity-80"
      : active
        ? "bg-surface-hover text-text-primary"
        : "cursor-pointer text-text-secondary hover:bg-surface-hover hover:text-text-primary"
  }`;

  if (href) {
    return (
      <Link href={href} title={label} aria-label={label} className={className}>
        {icon}
      </Link>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={className}
    >
      {icon}
    </button>
  );
}

/**
 * Brand mark — 22×22 rounded square with `m` glyph on the indigo→teal gradient.
 * @returns Inline mark element.
 */
function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-[22px] w-[22px] items-center justify-center font-mono text-[11px] font-bold"
      style={{
        background: "var(--color-accent-grad)",
        borderRadius: 5,
        color: "#0b0c10",
      }}
    >
      m
    </span>
  );
}

interface NavItemProps {
  /** Leading icon. */
  icon: React.ReactNode;
  /** Row label. */
  label: string;
  /** When set, the row renders as a `<Link>` to this href instead of a disabled button. */
  href?: string;
  /** Whether the row is the active route — surfaces the highlight state. */
  active?: boolean;
  /** When `href` is unset, row is rendered disabled with this title attribute. */
  disabledHint?: string;
}

/**
 * Top-level sidebar nav row. When `href` is set the row renders as a live
 * Next.js `<Link>` with the active-route highlight; otherwise it falls back
 * to a disabled button carrying the `disabledHint` tooltip (placeholder rows
 * whose backend route has not landed yet).
 *
 * @param props - Row configuration.
 * @returns Linked nav row or disabled button row.
 */
function NavItem({ icon, label, href, active, disabledHint }: NavItemProps) {
  if (href) {
    return (
      <Link
        href={href}
        aria-label={label}
        className={`flex h-7 w-full items-center gap-2 rounded-md border-none px-2 text-left text-[12px] font-medium transition-colors ${
          active
            ? "bg-surface-hover text-text-primary"
            : "bg-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        }`}
      >
        <span className="inline-flex text-text-muted">{icon}</span>
        <span className="flex-1">{label}</span>
      </Link>
    );
  }
  return (
    <button
      type="button"
      disabled
      aria-label={`${label} (${disabledHint ?? "disabled"})`}
      title={disabledHint}
      className="flex h-7 w-full cursor-not-allowed items-center gap-2 rounded-md border-none bg-transparent px-2 text-left text-[12px] font-medium text-text-secondary opacity-80"
    >
      <span className="inline-flex text-text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

interface ProjectGroup {
  /** Team metadata, or `null` for projects whose team isn't on the caller's list. */
  team: SidebarTeam | null;
  /** Projects belonging to this team, in the order returned by `listProjectsSlim()`. */
  projects: SidebarProject[];
}

/**
 * Bucket projects under their owning team, preserving the team order from
 * {@link SidebarProps.teams} and the project order from {@link SidebarProps.projects}.
 * Empty teams are dropped so the sidebar stays compact; an "Other" bucket
 * collects projects whose team is missing (defensive — should not happen
 * in practice).
 *
 * @param projects - Sidebar projects from `listProjectsSlim()`.
 * @param teams - Teams from `listUserTeamsAction()`.
 * @returns Groups in stable display order.
 */
function groupProjectsByTeam(
  projects: SidebarProject[],
  teams: SidebarTeam[],
): ProjectGroup[] {
  if (projects.length === 0) return [];

  const buckets = new Map<string, SidebarProject[]>();
  for (const project of projects) {
    const list = buckets.get(project.organizationId) ?? [];
    list.push(project);
    buckets.set(project.organizationId, list);
  }

  const groups: ProjectGroup[] = [];
  for (const team of teams) {
    const teamProjects = buckets.get(team.id);
    if (!teamProjects || teamProjects.length === 0) continue;
    groups.push({ team, projects: teamProjects });
    buckets.delete(team.id);
  }

  const orphans = [...buckets.values()].flat();
  if (orphans.length > 0) groups.push({ team: null, projects: orphans });

  return groups;
}

interface ProjectTeamGroupProps {
  /** Bucket of team + projects. */
  group: ProjectGroup;
  /** Currently active project route, if any. */
  activeProjectId: string | undefined;
  /** Whether to render a small top spacer above the team header. */
  showSpacer: boolean;
  /** Whether the team's project rows are hidden. */
  collapsed: boolean;
  /** Toggle the collapsed state. */
  onToggle: () => void;
}

/**
 * Team divider — chevron-toggled header carrying the team's accent color in
 * the chevron itself, followed (when expanded) by the team's project rows.
 * Renders only when at least two teams are present, so single-team accounts
 * keep the original flat list.
 *
 * @param props - Group, active route, and collapse handlers.
 * @returns Header button followed by project rows when expanded.
 */
function ProjectTeamGroup({
  group,
  activeProjectId,
  showSpacer,
  collapsed,
  onToggle,
}: ProjectTeamGroupProps) {
  const team = group.team;
  const teamColor = team ? getTeamColor(team.id) : null;
  const containsActive = activeProjectId
    ? group.projects.some((p) => p.id === activeProjectId)
    : false;

  return (
    <>
      {showSpacer && <span aria-hidden="true" className="block h-2" />}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={team ? `sidebar-team-${team.id}` : undefined}
        className="group/team flex h-[22px] w-full cursor-pointer items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-surface-hover/50"
      >
        <span
          aria-hidden="true"
          className={`inline-flex transition-transform duration-150 ${teamColor ? teamColor.text : "text-text-faint"}`}
          style={{ transform: collapsed ? undefined : "rotate(90deg)" }}
        >
          <IconChevronRight size={10} />
        </span>
        <span
          className={`flex-1 truncate text-left font-mono text-[10px] font-semibold uppercase tracking-[0.10em] ${
            containsActive ? "text-text-secondary" : "text-text-muted"
          } group-hover/team:text-text-secondary`}
          title={team?.name ?? "Other projects"}
        >
          {team?.name ?? "Other"}
        </span>
        {collapsed && (
          <span className="font-mono text-[10px] tabular-nums text-text-faint">
            {group.projects.length}
          </span>
        )}
      </button>
      {!collapsed && (
        <div
          id={team ? `sidebar-team-${team.id}` : undefined}
          className="flex flex-col gap-px"
        >
          {group.projects.map((p) => (
            <ProjectNavItem
              key={p.id}
              project={p}
              color={projectColor(p.identifier)}
              active={p.id === activeProjectId}
            />
          ))}
        </div>
      )}
    </>
  );
}

interface ProjectNavItemProps {
  /** Project to render. */
  project: SidebarProject;
  /** Computed dot color from {@link projectColor}. */
  color: string;
  /** Whether this row matches the active route. */
  active: boolean;
}

/**
 * Project row — color dot + name (truncated) + mono identifier.
 * @param props - Row data and active state.
 * @returns Linked button row.
 */
function ProjectNavItem({ project, color, active }: ProjectNavItemProps) {
  return (
    <Link
      href={`/project/${project.id}`}
      className={`flex h-[26px] items-center gap-2 rounded-md px-2 text-[12px] font-medium transition-colors ${
        active
          ? "bg-surface-hover text-text-primary"
          : "text-text-secondary hover:bg-surface-hover"
      }`}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 flex-shrink-0 rounded-[2px]"
        style={{ background: color }}
      />
      <span className="flex-1 truncate">{project.title}</span>
      <span className="font-mono text-[10px] text-text-faint">
        {project.identifier}
      </span>
    </Link>
  );
}

interface UserFooterProps {
  /** Current user. */
  user: SidebarUser;
  /** Whether settings route is currently active (highlights the gear). */
  settingsActive: boolean;
}

/**
 * Sidebar footer — avatar + name + settings + sign out.
 * @param props - User and active-route hint.
 * @returns Footer row pinned to bottom of sidebar.
 */
function UserFooter({ user, settingsActive }: UserFooterProps) {
  const router = useRouter();

  /** Sign out and redirect to sign-in page. */
  const handleSignOut = async () => {
    await signOut();
    router.replace("/sign-in");
  };

  const displayName = user.name?.trim() || user.email;

  return (
    <footer className="flex items-center gap-2 border-t border-border px-3 py-2.5">
      <Link
        href="/settings"
        title={displayName}
        aria-label={`${displayName} — account settings`}
        className="inline-flex flex-shrink-0 items-center rounded-full transition-opacity hover:opacity-90"
      >
        <Avatar name={displayName} src={user.image ?? undefined} size={26} />
      </Link>
      <Link
        href="/settings"
        title={displayName}
        aria-label={`${displayName} — account settings`}
        className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary no-underline transition-colors hover:text-accent-light"
      >
        {displayName}
      </Link>
      <Link
        href="/settings"
        aria-label="Settings"
        title="Settings"
        className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded transition-colors ${
          settingsActive
            ? "bg-surface-hover text-text-primary"
            : "text-text-muted hover:bg-surface-hover hover:text-text-secondary"
        }`}
      >
        <IconSettings size={13} />
      </Link>
      <button
        type="button"
        onClick={handleSignOut}
        aria-label="Sign out"
        title="Sign out"
        className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
      >
        <IconLogOut size={13} />
      </button>
    </footer>
  );
}

export default Sidebar;
