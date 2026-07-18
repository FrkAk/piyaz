"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ProjectCard } from "@/components/home/ProjectCard";
import { NewProjectButton } from "@/components/home/NewProjectButton";
import { ContinueBanner } from "@/components/home/ContinueBanner";
import { TeamFilterBar } from "@/components/home/TeamFilterBar";
import { TeamChip } from "@/components/shared/TeamChip";
import { roleHasProjectPermission } from "@/lib/auth/permissions";
import { projectKeys } from "@/lib/query/keys";
import { fetchProjectsPage } from "@/lib/query/queries";
import type { ProjectListEntry } from "@/lib/data/views";
import type { TeamView } from "@/lib/actions/team-list";

const dateFormatter = new Intl.DateTimeFormat("en-GB");

interface HomeGridProps {
  /** Teams the caller is a member of — passed from the server shell. */
  teams: TeamView[];
}

/**
 * Pure-client home grid. Reads the project list from TanStack Query (server
 * shell prefetches via `<HydrationBoundary>` so the first paint is SSR).
 * Owns the URL `?team=<id>` and `?group=team` filter state via
 * `useSearchParams` + `router.replace`.
 *
 * @param props - Teams from the server shell.
 * @returns Project grid with continue-banner, filter bar, and group sections.
 */
export function HomeGrid({ teams }: HomeGridProps) {
  const qc = useQueryClient();
  const searchParams = useSearchParams();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: projectKeys.list(),
      queryFn: fetchProjectsPage(qc),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  const projects = useMemo(() => {
    const seen = new Set<string>();
    const deduped: ProjectListEntry[] = [];
    for (const page of data?.pages ?? []) {
      for (const row of page.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        deduped.push(row);
      }
    }
    return deduped;
  }, [data]);

  const teamIds = useMemo(() => new Set(teams.map((t) => t.id)), [teams]);
  const requestedTeam = searchParams.get("team");
  const teamFilter =
    requestedTeam && teamIds.has(requestedTeam) ? requestedTeam : null;
  const groupByTeam = searchParams.get("group") === "team";

  const filteredProjects = teamFilter
    ? projects.filter((p) => p.organizationId === teamFilter)
    : projects;

  const activeProject = projects.find((p) => p.status === "active");

  return (
    <>
      {!teamFilter && activeProject && (
        <ContinueBanner
          projectId={activeProject.id}
          projectName={activeProject.title}
          projectIdentifier={activeProject.identifier}
          lastActiveNode={`${activeProject.taskStats.done}/${Math.max(
            activeProject.taskStats.total - activeProject.taskStats.cancelled,
            0,
          )} tasks done`}
          lastActive={dateFormatter.format(new Date(activeProject.updatedAt))}
        />
      )}

      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Projects
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Track projects across every team you&apos;re a member of.
          </p>
        </div>
        <NewProjectButton hasProjects={projects.length > 0} />
      </header>

      {teams.length > 1 ? (
        <TeamFilterBar
          teams={teams}
          activeTeamId={teamFilter}
          showGroupToggle={!teamFilter}
          groupActive={groupByTeam}
        />
      ) : null}

      {filteredProjects.length === 0 && projects.length === 0 ? (
        <EmptyHint
          title="No projects yet"
          body="Projects start in your coding agent. Use New project above for setup commands."
        />
      ) : null}

      {filteredProjects.length === 0 && projects.length > 0 ? (
        hasNextPage ? (
          <EmptyHint
            title="No matches on the loaded projects"
            body="Use Load more below to page through the rest of your projects."
          />
        ) : (
          <EmptyFilterHint teamFilter={teamFilter} teams={teams} />
        )
      ) : null}

      {groupByTeam && !teamFilter ? (
        <GroupedGrid projects={filteredProjects} teams={teams} />
      ) : (
        <FlatGrid projects={filteredProjects} />
      )}

      {hasNextPage ? (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="cursor-pointer rounded-lg border border-border bg-surface px-4 py-2 text-[12.5px] font-medium text-text-secondary shadow-[var(--shadow-button)] transition-colors hover:border-border-strong hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFetchingNextPage ? "Loading…" : "Load more projects"}
          </button>
        </div>
      ) : null}
    </>
  );
}

interface FlatGridProps {
  projects: ProjectListEntry[];
}

/**
 * Plain responsive card grid. The team chip on each card is suppressed when
 * every visible project belongs to the same team.
 *
 * @param props - Grid configuration.
 * @returns Responsive grid of `ProjectCard` items.
 */
function FlatGrid({ projects }: FlatGridProps) {
  const teamIds = new Set(projects.map((p) => p.organizationId));
  const showTeamChip = teamIds.size > 1;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          id={project.id}
          identifier={project.identifier}
          title={project.title}
          description={project.description}
          status={project.status}
          taskStats={project.taskStats}
          lastActive={dateFormatter.format(new Date(project.updatedAt))}
          canDelete={roleHasProjectPermission(project.memberRole, ["delete"])}
          team={
            showTeamChip
              ? { id: project.organization.id, name: project.organization.name }
              : undefined
          }
        />
      ))}
    </div>
  );
}

interface GroupedGridProps {
  projects: ProjectListEntry[];
  teams: TeamView[];
}

/**
 * Sectioned grid grouped by team. Empty teams render only the section
 * header so the membership stays visible.
 *
 * @param props - Group configuration.
 * @returns Stacked sections of project cards.
 */
function GroupedGrid({ projects, teams }: GroupedGridProps) {
  const projectsByTeam = new Map<string, ProjectListEntry[]>();
  for (const project of projects) {
    const list = projectsByTeam.get(project.organizationId) ?? [];
    list.push(project);
    projectsByTeam.set(project.organizationId, list);
  }

  return (
    <div className="space-y-8">
      {teams.map((team) => {
        const teamProjects = projectsByTeam.get(team.id) ?? [];
        return (
          <section key={team.id}>
            <header className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-2">
              <TeamChip team={team} size="sm" />
              {teamProjects.length > 0 ? (
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  {teamProjects.length}{" "}
                  {teamProjects.length === 1 ? "project" : "projects"}
                </span>
              ) : (
                <span className="text-xs italic text-text-muted/80">
                  no projects yet
                </span>
              )}
            </header>
            {teamProjects.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                {teamProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    id={project.id}
                    identifier={project.identifier}
                    title={project.title}
                    description={project.description}
                    status={project.status}
                    taskStats={project.taskStats}
                    lastActive={dateFormatter.format(
                      new Date(project.updatedAt),
                    )}
                    canDelete={roleHasProjectPermission(project.memberRole, [
                      "delete",
                    ])}
                  />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

interface EmptyHintProps {
  title: string;
  body: string;
}

/** Compact zero-state card shown when no projects exist in any team. */
function EmptyHint({ title, body }: EmptyHintProps) {
  return (
    <div className="mb-6 rounded-xl border border-dashed border-border-strong/60 bg-surface-raised/40 p-6">
      <h2 className="mb-1 text-sm font-semibold text-text-primary">{title}</h2>
      <p className="text-xs leading-relaxed text-text-muted">{body}</p>
    </div>
  );
}

interface EmptyFilterHintProps {
  teamFilter: string | null;
  teams: TeamView[];
}

/** Hint shown when the current filter has no matches. */
function EmptyFilterHint({ teamFilter, teams }: EmptyFilterHintProps) {
  const filteredTeam = teamFilter
    ? teams.find((t) => t.id === teamFilter)
    : undefined;
  return (
    <EmptyHint
      title={
        filteredTeam
          ? `No projects in ${filteredTeam.name}`
          : "No projects match this filter"
      }
      body="Pick a different team in the filter bar above, or clear it to see every team's projects."
    />
  );
}
