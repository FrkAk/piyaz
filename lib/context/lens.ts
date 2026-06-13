/**
 * Review-lens prompt scaffolding shared by the server review builder and the
 * workspace bundle preview. Pure constant — this module is imported from
 * client components, so it must never import "server-only" or any data
 * layer.
 */

/** Review-lens prompt body rendered under the "Review Lens Prompts" heading. */
export const REVIEW_LENS_PROMPTS = [
  "**The PR diff is the artifact under review.** Everything above — description, plan, execution record, decisions — is context the implementer recorded and may have drifted from the code. Verify claims against the code; never inherit them.",
  "",
  "Work from your harness, not from this bundle: read the full diff (`gh pr diff`), walk the touched files in the repo, run the project's tests / typecheck / lint when available, and check CI state. Then address each lens against the actual code. Cite real file paths and line numbers; `no findings` is a valid answer.",
  "",
  "- **Security**: input validation at trust boundaries, authn / authz on any new surface (endpoint, RPC, IPC, message handler, tool), secret and credential handling, injection of untrusted data (query, command, path, deserialization), unsafe concurrency or memory handling where the language allows it.",
  "- **Performance**: work added to hot paths, repeated or N+1 I/O, unbounded growth (memory, queues, caches, files), algorithmic complexity against realistic data sizes, storage access shapes that imply a missing index or batch.",
  "- **Reliability**: failure modes the plan claimed vs what the diff handles, swallowed or silent errors, idempotency on retry-eligible paths, atomicity and transactional boundaries, resource cleanup, behavior under partial failure.",
  "- **Observability**: failures and key state transitions surfaced through the project's existing logging / metrics / tracing idiom, no new silent failure paths, no unbounded-cardinality dimensions.",
  "- **Codebase standards**: conventions from the project's agent-instruction files (`CLAUDE.md`, `AGENTS.md`, or equivalent) and the neighboring code. Lint and formatting belong to the toolchain; flag substantive deviations only.",
].join("\n");
