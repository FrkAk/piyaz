"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { listTeamMembersAction } from "@/lib/actions/team-members";
import { listPendingInvitationsAction } from "@/lib/actions/team-invitations";
import {
  getOrCreateTeamInviteCodeAction,
  type InviteCodeMetadata,
} from "@/lib/actions/team-invite-code";
import {
  getDpaAcceptanceAction,
  type DpaAcceptanceState,
} from "@/lib/actions/legal";
import type { MemberView } from "@/lib/actions/team-members-map";
import type { InvitationView } from "@/lib/actions/team-invitations-map";
import type { TeamView } from "@/lib/actions/team-list";

import { initials } from "@/lib/ui/initials";
import { teamAvatarGradient } from "@/lib/ui/team-avatar";
import { roleStyle } from "@/lib/ui/role-badge";
import { IconX } from "@/components/shared/icons";
import { useModalChrome } from "@/hooks/useModalChrome";

import { MembersSection } from "./team-manage/MembersSection";
import { InviteSection } from "./team-manage/InviteSection";
import { IdentitySection } from "./team-manage/IdentitySection";
import { DangerZone } from "./team-manage/DangerZone";
import { DpaSection } from "./team-manage/DpaSection";

import {
  invalidateTeamManageCache,
  readTeamManageCache,
  updateTeamManageCache,
  writeTeamManageCache,
  type TeamManagePayload,
} from "./team-manage-cache";

interface TeamManageModalProps {
  /** Team being managed, or `null` when no modal should render. */
  team: TeamView | null;
  /** Caller's user id — drives self-row detection inside MembersSection. */
  currentUserId: string;
  /** Whether the deploy can send email; gates the invitation Resend action. */
  emailEnabled: boolean;
  /** Close handler — fires for X click, Esc, backdrop click, and forbidden state. */
  onClose: () => void;
}

/** Discriminated state machine for the modal body. */
type ModalPhase = "loading" | "ready" | "forbidden" | "error";

const ROLE_ORDER: Record<string, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

/** Owner > admin > member, alphabetical within a role tier. */
function sortMembers(list: MemberView[]): MemberView[] {
  return [...list].sort((a, b) => {
    const ra = ROLE_ORDER[a.role] ?? 3;
    const rb = ROLE_ORDER[b.role] ?? 3;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Fetch the three lazy team-management payloads in parallel. Non-admin
 * viewers skip the admin-only calls — those would just return `forbidden`
 * and would only surface a noisy network error.
 *
 * @param team - Team to fetch for. `team.role` decides admin gating.
 * @returns Discriminated outcome — `kind: 'ready'` carries the populated
 *   payload, `kind: 'forbidden'` indicates the caller is no longer a
 *   member, `kind: 'error'` carries a user-facing message.
 */
async function fetchTeamManagePayload(
  team: TeamView,
): Promise<
  | { kind: "ready"; payload: TeamManagePayload }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
> {
  const isAdminOrOwner = team.role === "owner" || team.role === "admin";
  const [membersResult, invitationsResult, inviteCodeResult, dpaResult] =
    await Promise.all([
      listTeamMembersAction({ organizationId: team.id }),
      isAdminOrOwner
        ? listPendingInvitationsAction({ organizationId: team.id })
        : Promise.resolve(null),
      isAdminOrOwner
        ? getOrCreateTeamInviteCodeAction({ organizationId: team.id })
        : Promise.resolve(null),
      team.role === "owner"
        ? getDpaAcceptanceAction({ organizationId: team.id })
        : Promise.resolve(null),
    ]);

  if (!membersResult.ok) {
    if (
      membersResult.code === "forbidden" ||
      membersResult.code === "not_found"
    ) {
      return { kind: "forbidden" };
    }
    return { kind: "error", message: membersResult.message };
  }

  return {
    kind: "ready",
    payload: {
      members: sortMembers(membersResult.data),
      invitations: invitationsResult?.ok ? invitationsResult.data : [],
      inviteCode: inviteCodeResult?.ok ? inviteCodeResult.data : null,
      teamName: team.name,
      teamSlug: team.slug,
      dpaAcceptance: dpaResult?.ok ? dpaResult.data : null,
    },
  };
}

/**
 * Centered modal for managing a single team — matches the codebase's
 * standard modal chrome (z-[60] backdrop, scale-fade entrance,
 * stack-aware Esc / focus trap via `useModalChrome`). The inner
 * destructive flow (delete-team) opens above this dialog at z-[70];
 * Esc dismisses the topmost dialog only.
 *
 * Open/close is fully driven by the `team` prop; the parent owns URL
 * sync (`?team=…`). The modal reads a tab-local SWR cache on mount so
 * subsequent re-opens render instantly while a background refetch
 * silently replaces the data.
 *
 * @param props - Modal configuration.
 * @returns Backdrop + centered panel, or `null` when no team is open.
 */
export function TeamManageModal({
  team,
  currentUserId,
  emailEnabled,
  onClose,
}: TeamManageModalProps) {
  return (
    <AnimatePresence>
      {team ? (
        <ModalInner
          key={team.id}
          team={team}
          currentUserId={currentUserId}
          emailEnabled={emailEnabled}
          onClose={onClose}
        />
      ) : null}
    </AnimatePresence>
  );
}

interface ModalInnerProps {
  team: TeamView;
  currentUserId: string;
  emailEnabled: boolean;
  onClose: () => void;
}

/**
 * Mount-only inner shell. Splitting it out lets the cache + fetch
 * machinery key off `team.id` via the AnimatePresence `key` so a fast
 * "switch teams" interaction tears down + remounts cleanly.
 *
 * @param props - Inner modal state.
 * @returns Backdrop + animated panel.
 */
function ModalInner({
  team,
  currentUserId,
  emailEnabled,
  onClose,
}: ModalInnerProps) {
  const reducedMotion = useReducedMotion();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalChrome(true, onClose, panelRef);

  const cached = readTeamManageCache(team.id);
  const [phase, setPhase] = useState<ModalPhase>(cached ? "ready" : "loading");
  const [members, setMembers] = useState<MemberView[]>(
    cached?.payload.members ?? [],
  );
  const [invitations, setInvitations] = useState<InvitationView[]>(
    cached?.payload.invitations ?? [],
  );
  const [inviteCode, setInviteCode] = useState<InviteCodeMetadata | null>(
    cached?.payload.inviteCode ?? null,
  );
  const [teamName, setTeamName] = useState(
    cached?.payload.teamName ?? team.name,
  );
  const [teamSlug, setTeamSlug] = useState(
    cached?.payload.teamSlug ?? team.slug,
  );
  const [dpaAcceptance, setDpaAcceptance] = useState<DpaAcceptanceState | null>(
    cached?.payload.dpaAcceptance ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [glowMemberId, setGlowMemberId] = useState<string | null>(null);

  const isAdminOrOwner = team.role === "owner" || team.role === "admin";
  const isOwner = team.role === "owner";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchTeamManagePayload(team);
        if (cancelled) return;
        if (result.kind === "ready") {
          setMembers(result.payload.members);
          setInvitations(result.payload.invitations);
          setInviteCode(result.payload.inviteCode);
          setTeamName(result.payload.teamName);
          setTeamSlug(result.payload.teamSlug);
          setDpaAcceptance(result.payload.dpaAcceptance);
          setPhase("ready");
          writeTeamManageCache(team.id, result.payload);
        } else if (result.kind === "forbidden") {
          invalidateTeamManageCache(team.id);
          setPhase("forbidden");
        } else {
          setPhase((prev) => (prev === "ready" ? "ready" : "error"));
          setErrorMessage(result.message);
        }
      } catch {
        if (cancelled) return;
        // A server action threw (network drop, server crash). Route to
        // the error state so the user can retry — never let the modal
        // get stuck on the skeleton or surface as an UnhandledRejection.
        setPhase((prev) => (prev === "ready" ? "ready" : "error"));
        setErrorMessage(
          "We couldn't reach the server. Check your connection and try again.",
        );
      }
    })().catch(() => {
      // Belt-and-braces: the IIFE above already catches, but keeping a
      // terminal .catch makes it impossible for a future refactor to
      // accidentally re-introduce an unhandled rejection here.
    });
    return () => {
      cancelled = true;
    };
  }, [team]);

  const refreshMembers = useCallback(async () => {
    const result = await listTeamMembersAction({ organizationId: team.id });
    if (result.ok) {
      const sorted = sortMembers(result.data);
      setMembers(sorted);
      updateTeamManageCache(team.id, { members: sorted });
    }
  }, [team.id]);

  const refreshInvitations = useCallback(async () => {
    const result = await listPendingInvitationsAction({
      organizationId: team.id,
    });
    if (result.ok) {
      setInvitations(result.data);
      updateTeamManageCache(team.id, { invitations: result.data });
    }
  }, [team.id]);

  const refreshInviteCode = useCallback(async () => {
    const result = await getOrCreateTeamInviteCodeAction({
      organizationId: team.id,
    });
    if (result.ok) {
      setInviteCode(result.data);
      updateTeamManageCache(team.id, { inviteCode: result.data });
    }
  }, [team.id]);

  const handleRoleChanged = useCallback(
    (memberId: string, newRole: "member" | "admin" | "owner") => {
      setError(null);
      setMembers((prev) => {
        const next = sortMembers(
          prev.map((m) => (m.id === memberId ? { ...m, role: newRole } : m)),
        );
        updateTeamManageCache(team.id, { members: next });
        return next;
      });
      setGlowMemberId(memberId);
      window.setTimeout(() => setGlowMemberId(null), 900);
    },
    [team.id],
  );

  const handleMemberRemoved = useCallback(
    (memberId: string) => {
      setError(null);
      setMembers((prev) => {
        const next = prev.filter((m) => m.id !== memberId);
        updateTeamManageCache(team.id, { members: next });
        return next;
      });
    },
    [team.id],
  );

  const handleRenamed = useCallback(
    (next: { name?: string; slug?: string }) => {
      setError(null);
      if (next.name !== undefined) setTeamName(next.name);
      if (next.slug !== undefined) setTeamSlug(next.slug);
      updateTeamManageCache(team.id, {
        teamName: next.name,
        teamSlug: next.slug,
      });
    },
    [team.id],
  );

  const handleInviteCodeChanged = useCallback(
    (next: InviteCodeMetadata) => {
      setInviteCode(next);
      updateTeamManageCache(team.id, { inviteCode: next });
    },
    [team.id],
  );

  const handleDpaAccepted = useCallback(
    (next: DpaAcceptanceState) => {
      setDpaAcceptance(next);
      updateTeamManageCache(team.id, { dpaAcceptance: next });
    },
    [team.id],
  );

  return (
    <motion.div
      key="backdrop"
      role="presentation"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reducedMotion ? 0.12 : 0.18,
        ease: "easeOut",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-base/70 px-4 py-12 backdrop-blur-sm sm:items-center sm:py-8"
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-manage-title"
        initial={
          reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }
        }
        animate={
          reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }
        }
        exit={
          reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }
        }
        transition={{ duration: 0.18, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="relative flex max-h-[calc(100vh-128px)] w-full max-w-[640px] flex-col overflow-hidden rounded-[10px] border border-border bg-surface shadow-[var(--shadow-float)]"
      >
        <ModalHeader team={team} teamName={teamName} onClose={onClose} />

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {phase === "loading" ? (
            <ModalSkeleton isAdminOrOwner={isAdminOrOwner} />
          ) : phase === "forbidden" ? (
            <ForbiddenState onClose={onClose} />
          ) : phase === "error" && members.length === 0 ? (
            <ErrorState
              message={errorMessage ?? "We couldn't load this team."}
              onRetry={() => {
                setPhase("loading");
                setErrorMessage(null);
              }}
            />
          ) : (
            <ModalBody
              team={team}
              teamName={teamName}
              teamSlug={teamSlug}
              members={members}
              invitations={invitations}
              inviteCode={inviteCode}
              dpaAcceptance={dpaAcceptance}
              currentUserId={currentUserId}
              emailEnabled={emailEnabled}
              isAdminOrOwner={isAdminOrOwner}
              isOwner={isOwner}
              glowMemberId={glowMemberId}
              error={error}
              setError={setError}
              refreshMembers={refreshMembers}
              refreshInvitations={refreshInvitations}
              refreshInviteCode={refreshInviteCode}
              onRoleChanged={handleRoleChanged}
              onMemberRemoved={handleMemberRemoved}
              onRenamed={handleRenamed}
              onInviteCodeChanged={handleInviteCodeChanged}
              onDpaAccepted={handleDpaAccepted}
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

interface ModalHeaderProps {
  team: TeamView;
  teamName: string;
  onClose: () => void;
}

/**
 * Sticky header for the modal — gradient avatar + team identity + role
 * chip + close X. Single source of header chrome inside the modal so
 * the body can scroll independently below.
 *
 * @param props - Header configuration.
 * @returns Header element pinned at the top of the modal panel.
 */
function ModalHeader({ team, teamName, onClose }: ModalHeaderProps) {
  const gradient = teamAvatarGradient(team.id);
  const role = roleStyle(team.role);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3.5 sm:px-6">
      <div
        aria-hidden="true"
        style={{
          background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
        }}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white shadow-[var(--shadow-card)]"
      >
        {initials({ name: teamName })}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="team-manage-title"
            className="truncate text-[14px] font-semibold text-text-primary"
          >
            {teamName}
          </h2>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${role.bg} ${role.text}`}
          >
            {role.dot ? (
              <span className={`h-1.5 w-1.5 rounded-full ${role.dot}`} />
            ) : null}
            {role.label}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
          {team.slug}
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close (Esc)"
        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
      >
        <IconX size={14} />
      </button>
    </header>
  );
}

interface ModalBodyProps {
  team: TeamView;
  teamName: string;
  teamSlug: string;
  members: MemberView[];
  invitations: InvitationView[];
  inviteCode: InviteCodeMetadata | null;
  dpaAcceptance: DpaAcceptanceState | null;
  currentUserId: string;
  emailEnabled: boolean;
  isAdminOrOwner: boolean;
  isOwner: boolean;
  glowMemberId: string | null;
  error: string | null;
  setError: (msg: string | null) => void;
  refreshMembers: () => Promise<void>;
  refreshInvitations: () => Promise<void>;
  refreshInviteCode: () => Promise<void>;
  onRoleChanged: (
    memberId: string,
    newRole: "member" | "admin" | "owner",
  ) => void;
  onMemberRemoved: (memberId: string) => void;
  onRenamed: (next: { name?: string; slug?: string }) => void;
  onInviteCodeChanged: (next: InviteCodeMetadata) => void;
  onDpaAccepted: (next: DpaAcceptanceState) => void;
}

/**
 * Section layout for the modal — Members (everyone), Invite + Identity
 * (admin/owner), Danger zone (owner only). Reuses the existing
 * single-purpose section components 1:1.
 *
 * @param props - Body data + callback bag.
 * @returns Vertical stack of section components and an alert slot.
 */
function ModalBody({
  team,
  teamName,
  teamSlug,
  members,
  invitations,
  inviteCode,
  dpaAcceptance,
  currentUserId,
  emailEnabled,
  isAdminOrOwner,
  isOwner,
  glowMemberId,
  error,
  setError,
  refreshMembers,
  refreshInvitations,
  refreshInviteCode,
  onRoleChanged,
  onMemberRemoved,
  onRenamed,
  onInviteCodeChanged,
  onDpaAccepted,
}: ModalBodyProps) {
  return (
    <div className="space-y-7">
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-cancelled/25 bg-cancelled/10 px-3 py-2 text-[12px] text-cancelled"
        >
          {error}
        </div>
      ) : null}

      <MembersSection
        teamId={team.id}
        members={members}
        currentUserId={currentUserId}
        viewerRole={team.role}
        glowMemberId={glowMemberId}
        onRoleChanged={onRoleChanged}
        onRemoved={onMemberRemoved}
        onError={setError}
      />

      {isAdminOrOwner ? (
        <InviteSection
          teamId={team.id}
          invitations={invitations}
          inviteCode={inviteCode}
          emailEnabled={emailEnabled}
          onInvitationsChanged={refreshInvitations}
          onInviteCodeChanged={onInviteCodeChanged}
          onRefreshInviteCode={refreshInviteCode}
          onRefreshMembers={refreshMembers}
          onError={setError}
        />
      ) : null}

      {isAdminOrOwner ? (
        <IdentitySection
          organizationId={team.id}
          currentName={teamName}
          currentSlug={teamSlug}
          onRenamed={onRenamed}
          onError={setError}
        />
      ) : null}

      {isOwner ? (
        <DpaSection
          organizationId={team.id}
          acceptance={dpaAcceptance}
          onAccepted={onDpaAccepted}
          onError={setError}
        />
      ) : null}

      {isOwner ? (
        <DangerZone teamId={team.id} teamName={teamName} onError={setError} />
      ) : null}
    </div>
  );
}

interface ModalSkeletonProps {
  isAdminOrOwner: boolean;
}

/**
 * Skeleton placeholder shown while the modal's lazy fetch is in flight.
 * Mirrors the final layout's vertical rhythm so data swap-in doesn't
 * shift content.
 *
 * @param props - Visibility hints for admin-only sections.
 * @returns Animated pulse blocks.
 */
function ModalSkeleton({ isAdminOrOwner }: ModalSkeletonProps) {
  return (
    <div className="space-y-7" aria-hidden="true">
      <div className="space-y-2.5">
        <div className="h-3 w-24 animate-pulse rounded bg-surface-raised/60" />
        <div className="space-y-1 rounded-xl border border-border bg-surface p-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-12 w-full animate-pulse rounded-md bg-surface-raised/40"
            />
          ))}
        </div>
      </div>
      {isAdminOrOwner ? (
        <>
          <div className="space-y-2.5">
            <div className="h-3 w-32 animate-pulse rounded bg-surface-raised/60" />
            <div className="h-24 animate-pulse rounded-xl bg-surface-raised/40" />
          </div>
          <div className="space-y-2.5">
            <div className="h-3 w-28 animate-pulse rounded bg-surface-raised/60" />
            <div className="h-32 animate-pulse rounded-xl bg-surface-raised/40" />
          </div>
        </>
      ) : null}
    </div>
  );
}

interface ForbiddenStateProps {
  onClose: () => void;
}

/**
 * Inline state shown when the server reports the caller is no longer a
 * member (or the team disappeared). Mirrors the spec's empty-state copy
 * style — terse, technical, no exclamation marks.
 *
 * @param props - Close callback.
 * @returns Centred message with a close button.
 */
function ForbiddenState({ onClose }: ForbiddenStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-transparent p-8 text-center">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        No longer a member
      </p>
      <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed text-text-muted">
        This team is no longer accessible to you. Either you left, your access
        was revoked, or the team was deleted.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-4 inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-border-strong bg-transparent px-3 text-[12px] font-semibold text-text-primary shadow-[var(--shadow-button)] transition-opacity hover:opacity-80"
      >
        Close
      </button>
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

/**
 * Inline state for transient network failures. Lets the user retry
 * without closing the modal.
 *
 * @param props - Error message + retry callback.
 * @returns Centred error card with a retry control.
 */
function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="rounded-xl border border-cancelled/25 bg-cancelled/5 p-5 text-center">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cancelled">
        Couldn&apos;t load
      </p>
      <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed text-text-muted">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-border-strong bg-transparent px-3 text-[12px] font-semibold text-text-primary shadow-[var(--shadow-button)] transition-opacity hover:opacity-80"
      >
        Try again
      </button>
    </div>
  );
}
