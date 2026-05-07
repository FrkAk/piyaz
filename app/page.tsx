import { listProjectsSlim, type ProjectListEntry } from '@/lib/graph/queries';
import { listUserTeamsAction, type TeamView } from '@/lib/actions/team-list';
import { requireMembership } from '@/lib/auth/membership';
import { roleHasProjectPermission } from '@/lib/auth/permissions';
import { TopBar } from '@/components/layout/TopBar';
import { AppShell } from '@/components/layout/AppShell';
import { PageShell } from '@/components/layout/PageShell';
import { ProjectCard } from '@/components/home/ProjectCard';
import { NewProjectButton } from '@/components/home/NewProjectButton';
import { ContinueBanner } from '@/components/home/ContinueBanner';
import { AutoRefresh } from '@/components/home/AutoRefresh';
import { TeamFilterBar } from '@/components/home/TeamFilterBar';
import { TeamChip } from '@/components/shared/TeamChip';

/** Force dynamic rendering — this page queries the database. */
export const dynamic = 'force-dynamic';

/** dd/mm/yyyy formatter used across the home grid for stable, locale-independent dates. */
const dateFormatter = new Intl.DateTimeFormat('en-GB');

interface HomePageProps {
  /** Search params hydrate the team filter and group-by toggle so refresh / link sharing preserves UI state. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Read a single string value from a search-param record, normalising the
 * `string | string[] | undefined` shape Next hands to server components.
 *
 * @param value - Raw search-param value.
 * @returns First defined string, or null when absent.
 */
function pickString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Home page — project grid spanning every team the caller is a member of.
 * Reads `?team=<id>` and `?group=team` from the URL so filters and the
 * group-by toggle survive refresh and are shareable as links.
 *
 * @param props - Search params from the URL.
 * @returns Server-rendered project grid with header CTA, filter bar, and team chips.
 */
export default async function HomePage({ searchParams }: HomePageProps) {
  await requireMembership();

  const [projects, teamsResult, params] = await Promise.all([
    listProjectsSlim(),
    listUserTeamsAction(),
    searchParams,
  ]);

  const teams = teamsResult.ok ? teamsResult.data : [];
  const teamIds = new Set(teams.map((t) => t.id));

  const requestedTeam = pickString(params.team);
  const teamFilter = requestedTeam && teamIds.has(requestedTeam) ? requestedTeam : null;
  const groupByTeam = pickString(params.group) === 'team';

  const filteredProjects = teamFilter
    ? projects.filter((p) => p.organizationId === teamFilter)
    : projects;

  const activeProject = projects.find((p) => p.status === 'active');

  return (
    <AppShell>
      <AutoRefresh />
      <TopBar />
      <PageShell>
        {!teamFilter && activeProject && (
          <ContinueBanner
            projectId={activeProject.id}
            projectName={activeProject.title}
            projectIdentifier={activeProject.identifier}
            lastActiveNode={`${activeProject.taskStats.done}/${Math.max(activeProject.taskStats.total - activeProject.taskStats.cancelled, 0)} tasks done`}
            lastActive={dateFormatter.format(activeProject.updatedAt)}
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
          <EmptyFilterHint teamFilter={teamFilter} teams={teams} />
        ) : null}

        {groupByTeam && !teamFilter ? (
          <GroupedGrid projects={filteredProjects} teams={teams} />
        ) : (
          <FlatGrid projects={filteredProjects} />
        )}
      </PageShell>
    </AppShell>
  );
}

interface FlatGridProps {
  projects: ProjectListEntry[];
}

/**
 * Plain responsive card grid. Uses card density (no placeholder) so the
 * project cards form a clean visual block; the New project CTA lives in
 * the page header instead of inside the grid.
 *
 * The team chip on each card is suppressed when every visible project
 * belongs to the same team — the chip becomes redundant noise then.
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
          tasksDone={project.taskStats.done}
          totalTasks={project.taskStats.total}
          cancelledTasks={project.taskStats.cancelled}
          tasksInProgress={project.taskStats.inProgress}
          lastActive={dateFormatter.format(project.updatedAt)}
          canDelete={roleHasProjectPermission(project.memberRole, ['delete'])}
          team={showTeamChip ? { id: project.organization.id, name: project.organization.name } : undefined}
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
 * Sectioned grid — one `<section>` per team the caller belongs to with
 * its `TeamChip`, project count, and the per-team subgrid. Empty teams
 * render only the section header with a one-line italic muted hint, so
 * the membership stays visible without injecting a card-shaped void into
 * the layout.
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
                  {teamProjects.length} {teamProjects.length === 1 ? 'project' : 'projects'}
                </span>
              ) : (
                <span className="text-xs italic text-text-muted/80">— no projects yet</span>
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
                    tasksDone={project.taskStats.done}
                    totalTasks={project.taskStats.total}
                    cancelledTasks={project.taskStats.cancelled}
                    tasksInProgress={project.taskStats.inProgress}
                    lastActive={dateFormatter.format(project.updatedAt)}
                    canDelete={roleHasProjectPermission(project.memberRole, ['delete'])}
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

/**
 * Compact zero-state card shown when there are no projects in any team.
 * Mirrors the dashed-border, low-contrast aesthetic of the design system's
 * placeholder treatment.
 */
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

/**
 * Hint shown when the user has projects somewhere but the current filter
 * has no matches. Surfaces the team name so the empty state is recoverable
 * without consulting the filter bar.
 */
function EmptyFilterHint({ teamFilter, teams }: EmptyFilterHintProps) {
  const filteredTeam = teamFilter ? teams.find((t) => t.id === teamFilter) : undefined;
  return (
    <EmptyHint
      title={filteredTeam ? `No projects in ${filteredTeam.name}` : 'No projects match this filter'}
      body="Pick a different team in the filter bar above, or clear it to see every team's projects."
    />
  );
}
