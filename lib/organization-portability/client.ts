/** Browser-safe organization workspace archive constants and helpers. */

/** MIME type used for organization workspace archives. */
export const ORGANIZATION_ARCHIVE_MEDIA_TYPE =
  "application/vnd.piyaz.organization+json";

/** Maximum encoded size accepted for one organization archive. */
export const MAX_ORGANIZATION_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * Build a safe deterministic download filename from an organization slug.
 *
 * @param slug - Organization slug or display label.
 * @returns Portable JSON download filename.
 */
export function organizationArchiveFilename(slug: string): string {
  const safeSlug = slug
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `piyaz-${safeSlug || "workspace"}-workspace.json`;
}

/**
 * Check whether the import form has a usable file and may submit.
 *
 * @param file - Selected file metadata.
 * @param dpaAccepted - Whether the owner accepted the destination DPA.
 * @param pending - Whether an import request is already running.
 * @returns True when the form may submit.
 */
export function canImportWorkspace(
  file: Pick<File, "name" | "size"> | null,
  dpaAccepted: boolean,
  pending: boolean,
): boolean {
  return (
    file !== null &&
    file.name.toLowerCase().endsWith(".json") &&
    file.size <= MAX_ORGANIZATION_ARCHIVE_BYTES &&
    dpaAccepted &&
    !pending
  );
}

/**
 * Read a client-safe error message from an archive route response.
 *
 * @param response - Failed export or import response.
 * @returns Server-provided safe message or a stable fallback.
 */
export async function readPortabilityError(
  response: Response,
): Promise<string> {
  const fallback = "Workspace transfer failed. Try again.";
  let body: string;
  try {
    body = await response.text();
  } catch {
    return fallback;
  }
  if (!body.trim()) return fallback;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      return typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error
        : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}
