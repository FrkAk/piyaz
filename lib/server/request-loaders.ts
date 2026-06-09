import "server-only";
import { cache } from "react";
import { listProjectsSlim } from "@/lib/graph/queries";
import { listUserTeamsAction } from "@/lib/actions/team-list";

/**
 * Sidebar project list, memoized for the lifetime of one RSC request.
 *
 * @returns Array of slim project rows for the current user.
 */
export const loadSidebarProjects = cache(listProjectsSlim);

/**
 * User team memberships, memoized for the lifetime of one RSC request.
 *
 * @returns Discriminated result containing the team list.
 */
export const loadUserTeams = cache(listUserTeamsAction);
