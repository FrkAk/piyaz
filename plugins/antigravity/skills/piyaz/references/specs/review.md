# Piyaz review spec

The verdict schema, the severity anchors, and the lens definitions behind a Piyaz review. Sole home for all three.

The review procedure (pre-flight, first-pass falsification, reconciliation, criteria evaluation, drift, downstream impact) lives in the `piyaz:review` agent file. What crosses the phase boundary back to composer lives in [contracts.md](contracts.md). How the prose sounds lives in [../role.md](../role.md).

## Contents

- §1 Verdict schema and output shape
- §2 Severity anchors
- §3 The five lenses
- §4 Lens depth: when to dispatch sub-reviewers
- §5 Rework intake fetch

---

## 1. Verdict schema and output shape

One of three values. Pick exactly one; do not hedge.

- **`approve`**: the work meets the acceptance criteria, the five lenses have no findings worth blocking on, CI is green, the PR is mergeable. Style-only nits and follow-up suggestions ride along under `Notes` without changing the verdict.
- **`request-changes`**: at least one lens has a finding that should be addressed before merge, or an acceptance criterion is unmet, or plan-versus-diff drift went unrecorded. The PR can land after the implementer rotates back through `in_progress` and pushes a fix. Name every blocking finding; the implementer rotates once on the fix, not on a guessing game.
- **`block`**: CI is red and unresolvable on the implementer's side, the work fails the task's premise, the diff implements a different task, or a security finding is severe enough that merging the current diff is unsafe regardless of small follow-up fixes. Block is rare; reserve it for cases where `request-changes` would understate the problem.

Red CI means the verdict cannot be `approve`. Pending or unresolved checks cap the verdict at `request-changes`, with unresolved CI as the sole blocking finding on an otherwise clean review.

The verdict is advisory in every mode. The HOTL operator owns the `in_review → done` transition and the merge.

### Output format

Keep it tight: a clean lens states what was checked and that it held; a finding gets the space its failure mode needs. Real file paths and line numbers, no marketing words, no throat-clearing.

```markdown
# Review verdict: <approve | request-changes | block>

**Task:** `<taskRef>` "<title>"
**PR:** <url> (state: <open / merged / closed>, CI: <green / red / pending>)
**ACs:** <N>/<M> satisfied per diff and executionRecord

## Security
<what you checked and what you found, paths cited; "no findings" is a valid answer>

## Performance
<what you checked and what you found, paths cited; "no findings" is a valid answer>

## Reliability
<what you checked and what you found, paths cited; "no findings" is a valid answer>

## Observability
<what you checked and what you found, paths cited; "no findings" is a valid answer>

## Codebase standards
<what you checked and what you found, paths cited; "no findings" is a valid answer>

## AC evaluation
- [x] "<AC text>" — satisfied by `<file>:<line>` (`<function or block>`).
- [ ] "<AC text>" — not verifiable from diff; <reason>.

## Deliverables
<per-artifact verdict with location; "not applicable" when the task ships none>

## Plan-vs-diff drift
<bullet list or "none">

## Downstream impact
- `<downstream taskRef>`: <one-line note on whether the edge needs a refresh>
<or "none">

## Notes
<follow-up suggestions that did not change the verdict; "none" is valid>
```

In dispatched mode (composer Phase 4), one summary line precedes the structured verdict so it stands out in the transcript:

> Review of `<taskRef>`: `<verdict>`. `<N>/<M>` ACs satisfied. `<one-sentence rationale>`. Full verdict follows.

In direct mode the structured verdict is the full reply, with no preamble line.

### Status line and structured fields

Every return ends with:

`STATUS: <DONE | BLOCKED> — <one-line reason>`

- `DONE`: a verdict was delivered. All three verdicts are `DONE`; a `block` verdict is a successful review, not a blocked phase.
- `BLOCKED`: the review could not run at all. `piyaz_get lens='review'` unreachable, the task not at `in_review`, or the PR handle missing with no dispatch URL and no deliverables to review through (no links, and no artifacts named by the criteria or description). Environmental `gh` failures (auth expiry, rate limit, network) return `STATUS: BLOCKED — environmental: <exact error>`, which the orchestrator surfaces without consuming the failure budget.

In dispatched mode the same values populate the structured `status` and `reason` fields; `verdict` is `null` whenever `status` is `BLOCKED`, which is how the orchestrator detects an unreviewable phase. The schema also carries `ciOnly`: true only when unresolved CI is the sole blocking finding, so the workflow re-polls CI instead of burning a fix rotation. Any other finding, including a payload defect the implementer must repair, means false.

---

## 2. Severity anchors

Reference points for where the lines sit, not templates to copy.

```
APPROVE (mobile, 5-file PR adding a per-user notifications toggle):
The new SettingsViewModel exposes a notificationsEnabled binding that
writes through to NotificationService.setEnabled
(Services/NotificationService.swift:88); the SwiftUI toggle in
Views/SettingsView.swift:142 binds against it. The service hop is
@MainActor; the underlying UNUserNotificationCenter call is wrapped in
withCheckedThrowingContinuation per the existing pattern at
Services/NotificationService.swift:42. Three ACs satisfied, snapshot
tests green, no plan drift. Tested for: keychain leakage on settings
export (no secrets stored in defaults), main-actor violations (verified
under the strict-concurrency build), rapid-toggle race (the service
serializes calls behind a Task queue at line 64). No findings worth
blocking. Notes: the watchOS counterpart is not in scope of this task;
tracked separately.

REQUEST-CHANGES (game engine, 7-file PR adding a frustum culling pass):
The new culling pass at src/render/cull.cpp:84 culls against the camera
frustum but uses the previous-frame view matrix at line 102; under fast
camera rotation the culled set lags one frame and edge geometry pops in
on the next render. The render loop at src/render/loop.cpp:218 already
holds the current-frame matrix and threads it through the draw
submission; route the same matrix into Cull::buildFrustum at line 96.
Three of four ACs satisfied; the "no visible popping on the spin
benchmark" AC needs a re-run after the fix. Not a block: the fix is a
one-argument plumbing change and the culling algorithm itself is sound;
one rotation through in_progress is enough.

BLOCK (ML inference, 12-file PR quantizing the recommender to int8):
The quantizer at training/quantize.py:144 uses per-tensor scale factors
for the embedding tables, but the embedding distribution measured by
scripts/inspect_embeddings.py has heavy tails: per-tensor scales saturate
0.4% of lookups and drop recall@10 by 3.1 points on the production eval
set (run 2026-05-12, eval/eval_log.csv). The task description named "no
measurable recall regression". CI is green because the existing harness
only asserts recall@1; recall@10 is the published production metric and
is not gated in tests. The diff ships a different quantization strategy
than the description named; the fix is per-channel or row-wise scaling
for the embedding tables, which is a substantive redesign of quantize.py
plus a new test surface. Block, not request-changes: one rotation
through in_progress will not land this.
```

The anchors carry three signals:

- Approve names what you tested for and why it did not land. No fluff, no padding.
- Request-changes cites the real failures, names a fix for each, leaves nits out. The count is whatever the diff earns.
- Block calls out a structural problem the implementer cannot fix in one rotation.

---

## 3. The five lenses

Run each against the diff and the bundle. Reasoning quality matters more than finding count, and a lens that reports no findings shows the work backing the claim.

Per lens: name the specific failure modes you tested for (the falsification hypotheses plus lens-specific ones), and for each cite the file and line that either falsifies it (no finding) or confirms it (finding). "No findings" is acceptable when the work genuinely does not touch the dimension, or when you can show the attack you tried and why it did not land; "no findings" with no reasoning trail is review-theater. Findings are real-risk items to fix before merge: style preferences, more-descriptive-name suggestions, alternative-design opinions, and hypothetical scaling concerns outside the task's scope are nits, and a finding whose concrete failure mode you cannot articulate is a nit.

**a. Security.** Trust-boundary input validation, authn and authz on new endpoints or RPC handlers, secret handling, SQL or command injection surfaces, deserialization of untrusted data, CSRF and SSRF on new HTTP paths, regex DoS on user-supplied patterns. Cite the project's existing security pattern (from upstream execution records or the codebase) when the new code crosses a boundary the project already protects, and flag the gap when it crosses one with no established pattern. Out of scope: speculative threat models for traffic the task does not promise to serve.

**b. Performance.** N+1 query patterns, unbounded memory growth, synchronous I/O on hot paths, missing indexes implied by new query shapes, blocking calls on event loops. Check the latency budget when the plan or description named one, and do not invent one when it did not. Cite the actual hot path; a code path that runs once at startup is not one.

**c. Reliability.** The failure modes the plan listed and whether the diff handles them, propagation of unexpected exceptions against silent swallowing, idempotency on retry-eligible endpoints, transactional boundaries on multi-step writes. Silent failures (catch blocks with no logging, fallbacks that mask the real error) are a recurring source of `request-changes`: cite the block, name the swallowed signal, recommend the structured propagation pattern the codebase already uses.

**d. Observability.** Logs, metrics, and traces consistent with the rest of the codebase on the new paths, error paths instrumented at the level existing ones use, no new high-cardinality dimensions that will blow the metrics backend, structured logging downstream tooling can parse. Out of scope: nice-to-have dashboards the task did not promise.

**e. Codebase standards.** The project's own conventions from `CLAUDE.md` or its equivalent, the patterns upstream execution records cite, the file structure and naming the rest of the codebase uses. Lint and formatting belong to the toolchain; flag substantive deviations, such as a new abstraction layer where the codebase is flat, a new dependency where a built-in would do, or a copy-paste of an existing helper instead of reusing it.

Six checks live in this lens because lint cannot catch them and they were the recurring miss in earlier reviews of cross-file flows:

- **Internal cross-references.** When the diff renumbers a step, renames an anchor, moves a file path, renames a function, or changes any token other docs cite, every old reference is stale. Search the repo (`grep`, `rg`) for the old form before declaring the lens clean. Particularly relevant in projects with multi-file flows that cross-cite by number.
- **Duplicate-source drift.** When the same content lives in two places by design (constants mirrored across modules, API schemas shared between client and server, i18n keys against source strings, docs that paraphrase code), the diff updates both sides. Read the second source when the diff touches the first and flag mismatches. Automated sync checks enforce surface equality only; they miss semantic drift when both sides were edited independently. When the duplication looks accidental and a single source of truth is feasible, raise it as a follow-up under `Notes`: the duplicate is the bug, the drift is the symptom.
- **Dead code.** Three flavors lint misses or under-reports: unreachable branches whose predicate cannot be true given upstream guards (cite the upstream condition); orphaned exports and helpers the diff stopped calling but did not remove (the only importer was deleted, the helper is reachable from nothing); and stranded params and locals a refactor left behind. Flag the path, name the upstream guard or deleted caller, recommend deletion.
- **Over-engineering and simplification.** Hold the diff to the project's stated simplicity guidelines, read from the agent-instruction file it ships (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or equivalent). Common forms, flagged with the path and the simpler shape: a 50-line implementation where 20 would do, a class wrapping one function, a generic type parameter with exactly one instantiation, a builder over a small struct, a two-level hierarchy with one empty level, fallbacks masking the real error, an abstraction for a single call site, configurability nobody asked for, error handling for paths that cannot fail. The fix belongs to the implementer's next rotation; when the project ships a simplification helper (a `/simplify` command, a `code-simplifier` agent), recommend it under `Notes` rather than running it.
- **Test coverage gaps.** When the diff adds or modifies executable behavior and the surrounding codebase clearly tests similar code (look at neighboring `*.test.*`, `*_test.*`, and `tests/` files), flag the gap. Out of scope: tests for trivial code, pure config, or docs-only changes.
- **Comments-and-docs audit.** Narrative or process content in comments and docs (session stories, future-work notes, "as discussed"), comments restating the adjacent code, references to nonexistent files, symbols, tools, or spec sections (grep every referenced anchor before declaring the lens clean), and violations of the repo's stated writing-style rules. Typical catches: phantom tool names, unanchored spec citations, future-work JSDoc.

---

## 4. Lens depth: when to dispatch sub-reviewers

Both thresholds hold when the `pr-review-toolkit` plugin is installed in the environment.

**Mandatory dispatch** when the diff meets any of: more than 10 files changed; touches authentication, authorization, or access-control code; touches a public API, RPC, tool, or IPC surface other callers depend on; touches persistence schema or a migration; modifies a wire format, public binary protocol, or release artifact; or the task carries a `security`, `safety`, or `compliance` cross-cutting tag. Dispatch `pr-review-toolkit:silent-failure-hunter` for the reliability lens, `pr-review-toolkit:type-design-analyzer` for new types under codebase standards, `pr-review-toolkit:pr-test-analyzer` for the test-coverage check, and `pr-review-toolkit:comment-analyzer` when the diff adds new docstring blocks. A threshold-crossing review that returns `approve` without naming which sub-reviewers ran is not a real review.

**Optional dispatch** for smaller, lower-risk diffs: run the lenses yourself and reach for a sub-reviewer when one lens has a finding that warrants depth.

Synthesize findings into the verdict rather than pasting sub-reviewer reports raw. On platforms without the toolkit (most Codex, Gemini, and Cursor installs), run the lenses yourself and name the missing harnesses under `Notes` so HOTL knows what coverage was skipped.

---

## 5. Rework intake fetch

Thread resolution state is GraphQL-only; REST does not expose it.

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewDecision
      reviewThreads(first: 100) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine diffSide subjectType
          comments(first: 50) { nodes { author { login } body createdAt url } }
        }
      }
    }
  }
}' -F owner='<owner>' -F repo='<repo>' -F pr=<num>
```

Filter to unresolved threads with `--jq '... | select(.isResolved | not)'`. `line` is null whenever `isOutdated` is true, so re-locate the anchor from `path` plus `originalLine` against current HEAD; the human commented on a diff that has since moved.

The PR-level state comes from `gh pr view <num|url> --json url,state,headRefName,reviewDecision,latestReviews,reviews,comments,statusCheckRollup,mergeable`. A `reviewDecision` of `CHANGES_REQUESTED` is the authoritative human signal; review bodies and issue-style drive-by comments are intake material too. Foreign commit authors come from `gh pr view <num> --json commits --jq '.commits[].authors[].login'`.
