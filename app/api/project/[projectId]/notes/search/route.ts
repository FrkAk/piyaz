import { NoteValidationError, searchNotes } from "@/lib/data/note";
import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { internalError } from "@/lib/api/error";
import { error, ok } from "@/lib/api/response";

/**
 * GET handler for full-text note search within a project.
 *
 * Returns up to 20 ranked hits as the slim tree projection; the body
 * column is never selected. Responses are query-parameterized with low
 * revalidation value, so this route ships plain 200s without
 * conditional-GET. A blank or missing `q` returns `[]` after the project
 * access gate; an over-length `q` surfaces as a typed 400.
 *
 * @param req - Incoming request; search text in the `q` query param.
 * @param params - Route params with projectId.
 * @returns 200, 400, 401, 404, or 500.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  try {
    const q = new URL(req.url).searchParams.get("q") ?? "";
    const hits = await searchNotes(ctx, projectId, q);
    return ok(hits);
  } catch (err) {
    if (err instanceof NoteValidationError) {
      return error(err.message, 400);
    }
    if (err instanceof ForbiddenError) {
      return error("Project not found", 404);
    }
    return internalError("notes-search", err);
  }
}
