"use client";

import Link from "next/link";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  IconAgent,
  IconBell,
  IconTag,
  IconUser,
  IconUsers,
} from "@/components/shared/icons";
import type { OAuthSessionView } from "@/lib/actions/oauth-session";
import type { TeamView } from "@/lib/actions/team-list";
import { listTeamMembersAction } from "@/lib/actions/team-members";
import { listPendingInvitationsAction } from "@/lib/actions/team-invitations";
import { getOrCreateTeamInviteCodeAction } from "@/lib/actions/team-invite-code";
import { getDpaAcceptanceAction } from "@/lib/actions/legal";
import { AccountTab } from "./AccountTab";
import { AgentsTab } from "./AgentsTab";
import { PlaceholderTab } from "./PlaceholderTab";
import { TeamsTab } from "./TeamsTab";
import { TeamManageModal } from "./TeamManageModal";
import {
  clearTeamManageCache,
  readTeamManageCache,
  writeTeamManageCache,
} from "./team-manage-cache";

interface SettingsTab {
  /** URL slug used in `?tab=…`. */
  id: TabId;
  /** Visible label rendered in the rail. */
  label: string;
  /** Inline icon node (sized 13). */
  icon: ReactNode;
}

const TABS: readonly SettingsTab[] = [
  { id: "account", label: "Account", icon: <IconUser size={13} /> },
  { id: "teams", label: "Teams", icon: <IconUsers size={13} /> },
  { id: "agents", label: "Agents & devices", icon: <IconAgent size={13} /> },
  { id: "notifications", label: "Notifications", icon: <IconBell size={13} /> },
  { id: "billing", label: "Billing", icon: <IconTag size={13} /> },
];

type TabId = "account" | "teams" | "agents" | "notifications" | "billing";

const TAB_IDS: ReadonlySet<TabId> = new Set<TabId>([
  "account",
  "teams",
  "agents",
  "notifications",
  "billing",
]);

const ROLE_ORDER: Record<string, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

/**
 * Coerce a raw `?tab=` value into a known canonical tab id.
 *
 * @param raw - Raw query-string value (or `null` when the param is absent).
 * @returns The matched tab id, or `'account'` for unknown or missing values.
 */
function resolveTab(raw: string | null): TabId {
  if (raw && (TAB_IDS as Set<string>).has(raw)) return raw as TabId;
  return "account";
}

/** Owner > admin > member, alphabetical within a role tier. */
function sortTeams(list: TeamView[]): TeamView[] {
  return [...list].sort((a, b) => {
    const ra = ROLE_ORDER[a.role] ?? 3;
    const rb = ROLE_ORDER[b.role] ?? 3;
    if (ra !== rb) return ra - rb;
    return b.createdAt.valueOf() - a.createdAt.valueOf();
  });
}

interface SettingsViewProps {
  /** Signed-in user's identity slice — name, email, createdAt for display. */
  user: {
    id: string;
    name: string;
    email: string;
    createdAt: Date | string;
  };
  /** Credential row's updatedAt (password last changed), or null when the
   *  user has no password-bearing credential account. */
  passwordUpdatedAt: Date | string | null;
  /** Whether the email-change flow is available (email-capable deploy AND
   *  credential holder), resolved server-side per request. */
  emailChangeEnabled: boolean;
  /** Initial OAuth device sessions, fetched server-side. */
  initialSessions: OAuthSessionView[];
  /** Initial team memberships, fetched server-side. */
  initialTeams: TeamView[];
}

/**
 * Settings sub-shell — 240px left rail (Account / Teams / Agents & devices /
 * Notifications / Billing) plus a content column that hosts the active tab
 * and a right-pinned slide-over for team management. URL-syncs tab + team
 * via `?tab=…&team=…` so deep links and refresh both work.
 *
 * @param props - Hydrated server data + identity slice.
 * @returns Two-column rail + content layout filling the AppShell main area.
 */
export function SettingsView({
  user,
  passwordUpdatedAt,
  emailChangeEnabled,
  initialSessions,
  initialTeams,
}: SettingsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = resolveTab(searchParams.get("tab"));
  const teamParam = searchParams.get("team");

  const [teams, setTeams] = useState<TeamView[]>(() => sortTeams(initialTeams));

  useEffect(() => {
    // Defense in depth: drop any cached team-manage payloads from a
    // previous identity when the signed-in user changes within the same
    // tab (sign-out → sign-in is client-side and does not reload the
    // module). UUIDs already prevent cross-user UI exposure; this also
    // evicts the data from JS memory.
    clearTeamManageCache();
  }, [user.id]);

  const activeTeam =
    tab === "teams" && teamParam
      ? (teams.find((t) => t.id === teamParam) ?? null)
      : null;

  const buildHref = useCallback(
    (next: TabId, options?: { teamId?: string | null }): string => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "account") params.delete("tab");
      else params.set("tab", next);
      if (options?.teamId !== undefined) {
        if (options.teamId) params.set("team", options.teamId);
        else params.delete("team");
      }
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );

  const openManage = useCallback(
    (teamId: string) => {
      router.replace(buildHref("teams", { teamId }), { scroll: false });
    },
    [buildHref, router],
  );

  const closeManage = useCallback(() => {
    router.replace(buildHref("teams", { teamId: null }), { scroll: false });
  }, [buildHref, router]);

  const prefetchManage = useCallback(
    (teamId: string) => {
      if (readTeamManageCache(teamId)) return;
      const team = teams.find((t) => t.id === teamId);
      if (!team) return;
      const isAdmin = team.role === "owner" || team.role === "admin";

      Promise.all([
        listTeamMembersAction({ organizationId: teamId }),
        isAdmin
          ? listPendingInvitationsAction({ organizationId: teamId })
          : Promise.resolve(null),
        isAdmin
          ? getOrCreateTeamInviteCodeAction({ organizationId: teamId })
          : Promise.resolve(null),
        team.role === "owner"
          ? getDpaAcceptanceAction({ organizationId: teamId })
          : Promise.resolve(null),
      ])
        .then(
          ([membersResult, invitationsResult, inviteCodeResult, dpaResult]) => {
            if (!membersResult.ok) return;
            writeTeamManageCache(teamId, {
              members: membersResult.data,
              invitations: invitationsResult?.ok ? invitationsResult.data : [],
              inviteCode: inviteCodeResult?.ok ? inviteCodeResult.data : null,
              teamName: team.name,
              teamSlug: team.slug,
              dpaAcceptance: dpaResult?.ok ? dpaResult.data : null,
            });
          },
        )
        .catch(() => {
          // Prefetch is best-effort — if the network fails, the panel's
          // own fetch on click will surface the error in-context. Silent
          // failure here prevents an UnhandledRejection from a hover.
        });
    },
    [teams],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <aside
        aria-label="Settings sections"
        className="hidden w-60 shrink-0 flex-col gap-px overflow-y-auto border-r border-border px-3 py-5 md:flex"
        style={{ background: "var(--color-base-2)" }}
      >
        <p className="px-2 pb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Settings
        </p>
        {TABS.map((t) => (
          <NavItem
            key={t.id}
            href={buildHref(t.id, { teamId: null })}
            active={tab === t.id}
            icon={t.icon}
            label={t.label}
          />
        ))}
      </aside>

      <nav
        aria-label="Settings sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2 md:hidden"
        style={{ background: "var(--color-base-2)" }}
      >
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={buildHref(t.id, { teamId: null })}
            replace
            scroll={false}
            aria-current={tab === t.id ? "page" : undefined}
            className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
              tab === t.id
                ? "bg-surface-hover text-text-primary"
                : "text-text-muted hover:bg-surface-hover hover:text-text-secondary"
            }`}
          >
            <span
              className={tab === t.id ? "text-accent-light" : ""}
              aria-hidden="true"
            >
              {t.icon}
            </span>
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-6 py-8 sm:px-10">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              {tab === "account" && (
                <AccountTab
                  user={user}
                  passwordUpdatedAt={passwordUpdatedAt}
                  emailChangeEnabled={emailChangeEnabled}
                />
              )}
              {tab === "teams" && (
                <TeamsTab
                  teams={teams}
                  setTeams={setTeams as Dispatch<SetStateAction<TeamView[]>>}
                  userName={user.name}
                  activeTeamId={teamParam ?? null}
                  onManage={openManage}
                  onPrefetch={prefetchManage}
                />
              )}
              {tab === "agents" && (
                <AgentsTab initialSessions={initialSessions} />
              )}
              {tab === "notifications" && (
                <PlaceholderTab
                  title="Notifications"
                  subhead="Inbox, email, and digest preferences will live here."
                />
              )}
              {tab === "billing" && (
                <PlaceholderTab
                  title="Billing"
                  subhead="Subscription tiers and invoices will appear here when billing ships."
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <TeamManageModal
        team={tab === "teams" ? activeTeam : null}
        currentUserId={user.id}
        onClose={closeManage}
      />
    </div>
  );
}

interface NavItemProps {
  /** Full href that activates this rail row (`/settings?tab=…`). */
  href: string;
  /** True when this row matches the current tab — applies the active styling. */
  active: boolean;
  /** Inline icon node placed before the label. */
  icon: ReactNode;
  /** Visible label text. */
  label: string;
}

/**
 * Single rail row — icon + label, anchor styled like the sidebar's NavItem.
 * Uses `replace` so tab switches don't grow the history stack.
 *
 * @param props - Rail row configuration.
 * @returns Active-aware `<Link>` element.
 */
function NavItem({ href, active, icon, label }: NavItemProps) {
  return (
    <Link
      href={href}
      replace
      scroll={false}
      aria-current={active ? "page" : undefined}
      className={`flex h-7 items-center gap-2 rounded-md px-2 text-[12.5px] font-medium transition-colors ${
        active
          ? "bg-surface-hover text-text-primary"
          : "text-text-muted hover:bg-surface-hover hover:text-text-secondary"
      }`}
    >
      <span className={active ? "text-accent-light" : ""} aria-hidden="true">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}
