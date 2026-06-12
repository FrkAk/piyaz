/**
 * Review-lens prompt scaffolding shared by the server review builder and the
 * workspace bundle preview. Pure constant — this module is imported from
 * client components, so it must never import "server-only" or any data
 * layer.
 */

/** Review-lens prompt body rendered under the "Review Lens Prompts" heading. */
export const REVIEW_LENS_PROMPTS = [
  "When producing the structured verdict, address each lens against the diff and the executionRecord above. Cite real file paths and line numbers; `no findings` is a valid answer.",
  "",
  "- **Security**: trust-boundary input validation, authn / authz on new endpoints, secret handling, SQL or command injection surfaces, deserialization of untrusted data.",
  "- **Performance**: N+1 query patterns, unbounded memory growth, synchronous I/O on hot paths, missing indexes implied by new query shapes.",
  "- **Reliability**: failure modes the plan listed vs the diff's handling, silent error swallowing, idempotency on retry-eligible paths, transactional boundaries.",
  "- **Observability**: logs / metrics / traces consistent with the rest of the codebase, no high-cardinality dimensions that blow the metrics backend.",
  "- **Codebase standards**: project conventions from `CLAUDE.md` and the patterns upstream executionRecord entries cite. Lint and formatting belong to the toolchain; flag substantive deviations only.",
].join("\n");
