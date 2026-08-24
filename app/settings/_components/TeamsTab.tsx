"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/shared/Button";
import { IconDoc, IconLink, IconPlus } from "@/components/shared/icons";
import { listUserTeamsAction, type TeamView } from "@/lib/actions/team-list";
import { invalidateTeamManageCache } from "./team-manage-cache";
import { CreateTeamPanel } from "./CreateTeamPanel";
import { EmptyState } from "./EmptyState";
import { JoinTeamPanel } from "./JoinTeamPanel";
import { ImportWorkspacePanel } from "./ImportWorkspacePanel";
import { TeamCard } from "./TeamCard";

interface TeamsTabProps {
  /** Live team list owned by the parent SettingsView. */
  teams: TeamView[];
  /** Setter for the team list — used after create/join/leave to update in place. */
  setTeams: Dispatch<SetStateAction<TeamView[]>>;
  /** Caller's display name — used to personalize the create-team placeholder. */
  userName?: string | null;
  /** Currently open team in the manage panel, or `null` when no panel is open. */
  activeTeamId: string | null;
  /** Open the manage panel for a team. */
  onManage: (teamId: string) => void;
  /** Hint that the manage panel is likely to open soon — warms the cache. */
  onPrefetch: (teamId: string) => void;
}

/**
 * Sort teams by `createdAt` descending — newest first. There is no
 * "active" team to pin, so the list mirrors team creation order.
 */
function sortTeams(list: TeamView[]): TeamView[] {
  return [...list].sort(
    (a, b) => b.createdAt.valueOf() - a.createdAt.valueOf(),
  );
}

/**
 * Teams tab — lists every team the user belongs to with role badges and
 * a Manage button that opens the slide-over panel. Owns the
 * create/join/leave UX; team list data lives in the parent so the panel
 * can find the active team without duplicating state.
 *
 * @param props - Controlled team list + callbacks.
 * @returns Rendered tab body.
 */
export function TeamsTab({
  teams,
  setTeams,
  userName,
  activeTeamId,
  onManage,
  onPrefetch,
}: TeamsTabProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [glowId, setGlowId] = useState<string | null>(null);

  /**
   * Open only the create-team panel.
   *
   * @returns Nothing.
   */
  const startCreating = useCallback((): void => {
    setJoining(false);
    setImporting(false);
    setCreating(true);
  }, []);

  /**
   * Open only the join-team panel.
   *
   * @returns Nothing.
   */
  const startJoining = useCallback((): void => {
    setCreating(false);
    setImporting(false);
    setJoining(true);
  }, []);

  /**
   * Open only the workspace-import panel.
   *
   * @returns Nothing.
   */
  const startImporting = useCallback((): void => {
    setCreating(false);
    setJoining(false);
    setImporting(true);
  }, []);

  /**
   * Re-fetch the user's teams and replace local state on success.
   *
   * @returns `true` if the list was refreshed, `false` if the action
   *   failed. Callers must surface the failure when their UX depends on
   *   the new state being visible.
   */
  const refresh = useCallback(async (): Promise<boolean> => {
    const result = await listUserTeamsAction();
    if (!result.ok) return false;
    setTeams(sortTeams(result.data));
    return true;
  }, [setTeams]);

  const handleLeft = useCallback(
    (organizationId: string) => {
      setError(null);
      setTeams((prev) => prev.filter((t) => t.id !== organizationId));
      invalidateTeamManageCache(organizationId);
      router.refresh();
    },
    [router, setTeams],
  );

  /**
   * Refresh and highlight a newly joined, created, or imported team.
   *
   * @param organizationId - New organization identifier.
   * @returns True when the refreshed list includes the new organization.
   */
  const handleAdded = useCallback(
    async (organizationId: string): Promise<boolean> => {
      setError(null);
      const refreshed = await refresh();
      if (!refreshed) {
        setError(
          "You've been added to the team, but we couldn't refresh the list. Reload the page to see it.",
        );
        return false;
      }
      setCreating(false);
      setJoining(false);
      setImporting(false);
      router.refresh();
      setGlowId(organizationId);
      window.setTimeout(() => setGlowId(null), 900);
      return true;
    },
    [refresh, router],
  );

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-[22px] font-semibold leading-tight text-text-primary">
          Teams
        </h1>
        <p className="mt-1 text-[13px] text-text-muted">
          Workspaces you collaborate in. Projects belong to teams; agents
          inherit team permissions.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="md"
          icon={<IconPlus size={12} />}
          onClick={startCreating}
          disabled={creating}
        >
          Create team
        </Button>
        <Button
          variant="ghost"
          size="md"
          icon={<IconLink size={12} />}
          onClick={startJoining}
          disabled={joining}
        >
          Join with code
        </Button>
        <Button
          variant="ghost"
          size="md"
          icon={<IconDoc size={12} />}
          onClick={startImporting}
          disabled={importing}
        >
          Import workspace
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-cancelled/25 bg-cancelled/10 px-3 py-2 text-xs text-cancelled"
        >
          {error}
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {creating ? (
          <motion.div
            key="create-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{ overflow: "hidden" }}
          >
            <CreateTeamPanel
              onCancel={() => setCreating(false)}
              onCreated={handleAdded}
              userName={userName}
            />
          </motion.div>
        ) : null}
        {joining ? (
          <motion.div
            key="join-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{ overflow: "hidden" }}
          >
            <JoinTeamPanel
              onCancel={() => setJoining(false)}
              onJoined={handleAdded}
            />
          </motion.div>
        ) : null}
        {importing ? (
          <motion.div
            key="import-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{ overflow: "hidden" }}
          >
            <ImportWorkspacePanel
              onCancel={() => setImporting(false)}
              onImported={handleAdded}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {teams.length === 0 && !creating && !joining && !importing ? (
        <EmptyState
          icon={
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              className="h-6 w-6"
            >
              <path d="M5.5 7a2.5 2.5 0 110-5 2.5 2.5 0 010 5zM2 13a3.5 3.5 0 117 0v.5a.5.5 0 01-.5.5h-6a.5.5 0 01-.5-.5V13zm9.5-6a2 2 0 110-4 2 2 0 010 4zM10 13a3 3 0 015.99-.176A.5.5 0 0115.5 13h-3.998A.5.5 0 0110 13z" />
            </svg>
          }
          title="You're not in any teams yet"
          body="Create a team to start a fresh workspace, or join an existing one with an invite code from an admin."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" size="sm" onClick={startCreating}>
                Create your first team
              </Button>
              <Button variant="secondary" size="sm" onClick={startJoining}>
                Join with code
              </Button>
            </div>
          }
        />
      ) : (
        <motion.ul layout className="space-y-2">
          <AnimatePresence initial={false}>
            {teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                glow={glowId === team.id}
                active={activeTeamId === team.id}
                onManage={onManage}
                onPrefetch={onPrefetch}
                onLeft={handleLeft}
                onError={setError}
              />
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
    </section>
  );
}
