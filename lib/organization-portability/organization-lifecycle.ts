/** Better Auth organization lifecycle orchestration for workspace imports. */

import "server-only";
import { mapBetterAuthError } from "@/lib/actions/team-errors";
import type { TeamActionFailureCode } from "@/lib/actions/team-errors";
import { auth } from "@/lib/auth";
import { deriveTeamSlug } from "@/lib/team/derive-slug";
import { SLUG_MAX, TEAM_NAME_MAX } from "@/lib/team/slug-rules";

const IMPORTED_ORGANIZATION_FALLBACK_NAME = "Imported workspace";

/** Organization created as the destination for one imported workspace. */
export type ImportedOrganization = {
  id: string;
  name: string;
  slug: string;
};

/** Typed organization creation or deletion failure. */
export class OrganizationLifecycleError extends Error {
  /**
   * Create a lifecycle error from the shared Better Auth error taxonomy.
   *
   * @param code - Mapped team action failure code.
   */
  constructor(readonly code: TeamActionFailureCode) {
    super(`Organization lifecycle failed: ${code}`);
    this.name = "OrganizationLifecycleError";
  }
}

/**
 * Append a short random suffix without exceeding the team slug limit.
 *
 * @param baseSlug - Valid base slug.
 * @returns Collision-resistant valid slug candidate.
 */
function suffixedSlug(baseSlug: string): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const prefix = baseSlug
    .slice(0, SLUG_MAX - suffix.length - 1)
    .replace(/-+$/g, "");
  return `${prefix}-${suffix}`;
}

/**
 * Convert source identity into a valid destination display name.
 *
 * @param name - Organization name preserved in the source archive.
 * @returns Trimmed, non-empty name within the current team limit.
 */
function importedOrganizationName(name: string): string {
  const candidate = name.trim() || IMPORTED_ORGANIZATION_FALLBACK_NAME;
  const truncated = candidate.slice(0, TEAM_NAME_MAX);
  return /[\uD800-\uDBFF]$/.test(truncated)
    ? truncated.slice(0, -1)
    : truncated;
}

/**
 * Create a new organization for a validated workspace archive.
 *
 * @param input - Archived identity, accepted DPA marker, and request headers.
 * @returns Newly created destination organization.
 * @throws {OrganizationLifecycleError} When creation fails or all five slug
 *   candidates collide.
 */
export async function createImportedOrganization(input: {
  name: string;
  slug: string;
  dpaAccepted: true;
  headers: Headers;
}): Promise<ImportedOrganization> {
  const baseSlug = deriveTeamSlug(input.slug);
  const name = importedOrganizationName(input.name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : suffixedSlug(baseSlug);
    try {
      const body = {
        name,
        slug,
        dpaAccepted: input.dpaAccepted,
      };
      const created = await auth.api.createOrganization({
        body,
        headers: input.headers,
      });
      if (!created) throw new OrganizationLifecycleError("unknown");
      return { id: created.id, name: created.name, slug: created.slug };
    } catch (error) {
      if (error instanceof OrganizationLifecycleError) throw error;
      const code = mapBetterAuthError(error);
      if (code === "slug_taken") continue;
      throw new OrganizationLifecycleError(code);
    }
  }
  throw new OrganizationLifecycleError("slug_taken");
}

/**
 * Delete a newly created organization after workspace restoration fails.
 *
 * @param input - Explicit destination organization and request headers.
 * @returns Promise that resolves after Better Auth deletes the organization.
 * @throws {OrganizationLifecycleError} When deletion fails.
 */
export async function deleteImportedOrganization(input: {
  organizationId: string;
  headers: Headers;
}): Promise<void> {
  try {
    await auth.api.deleteOrganization({
      body: { organizationId: input.organizationId },
      headers: input.headers,
    });
  } catch (error) {
    throw new OrganizationLifecycleError(mapBetterAuthError(error));
  }
}
