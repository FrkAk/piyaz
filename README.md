![Mymir](assets/mymir-logo.png)
> Context management for the agent-native engineering era.

<p align="center">
  <a href="#claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?style=flat-square&logo=anthropic&logoColor=white" /></a>
  &nbsp;&nbsp;
  <a href="#codex"><img alt="Codex" src="https://img.shields.io/badge/Codex-000000?style=flat-square&logo=openai&logoColor=white" /></a>
  &nbsp;&nbsp;
  <a href="#cursor"><img alt="Cursor" src="https://img.shields.io/badge/Cursor-000000?style=flat-square&logo=cursor&logoColor=white" /></a>
  &nbsp;&nbsp;
  <a href="#antigravity"><img alt="Antigravity" src="https://img.shields.io/badge/Antigravity-4285F4?style=flat-square&logo=google&logoColor=white" /></a>
</p>

<p align="center">
  <img src="assets/mymir-demo.gif" alt="Mymir demo" width="900" />
</p>

Most of us aren't really writing code anymore, we're directing agents that do. But those agents have no memory. Every session starts from zero, and engineers end up spending their time re-explaining what was built, why decisions were made, and what still needs to happen. That's not engineering, that's babysitting.

Mymir replaces that cycle. It's not just a context layer your agents read from, it's an end-to-end project management tool that agents operate natively. Mymir creates tasks, refines them, plans implementations, provides the right context at the right stage, and tracks everything that happens. Your agent harness doesn't need a briefing. It walks into every session knowing exactly what to do next and why.

---

## Use the hosted version (no clone)

Mymir is hosted at [app.mymir.dev](https://app.mymir.dev). The plugin installs into your coding agent once, at the user level, and works in every project you open, no clone required. Run the one-time install for your agent and sign in when prompted (OAuth, once per machine).

### Claude Code

```bash
claude plugin marketplace add FrkAk/mymir
claude plugin install mymir@mymir
```

Then run `/mcp`, select **mymir**, and complete the browser sign-in.

### Codex

```bash
codex plugin marketplace add FrkAk/mymir
```

Open Codex, run `/plugin`, install **Mymir**, restart, and authenticate when prompted. Invoke the main skill with `$mymir`. (If your Codex build can't resolve the root marketplace, append `--sparse plugins`.)

### Cursor

- **MCP only, any plan (quick start):** open the install deeplink, then sign in on the first tool call:

  ```text
  cursor://anysphere.cursor-deeplink/mcp/install?name=mymir&config=eyJ1cmwiOiJodHRwczovL2FwcC5teW1pci5kZXYvYXBpL21jcCJ9
  ```

- **Team/Enterprise (skills + MCP):** *Dashboard → Settings → Plugins → Team Marketplaces → Add Marketplace → Import from Repo*, paste `https://github.com/FrkAk/mymir`. Team Marketplaces is a Teams/Enterprise feature.
- **Public Marketplace:** listing in the [Cursor Marketplace](https://cursor.com/marketplace) requires submission and manual review. Search-and-install lands once Mymir is published.

### Antigravity

Add the Mymir MCP server to your global config and authenticate (Antigravity handles OAuth automatically). The IDE and the CLI share one config at `~/.gemini/config/mcp_config.json` (in the IDE: MCP Store → Manage MCP Servers → View raw config):

```json
{
  "mcpServers": {
    "mymir": { "serverUrl": "https://app.mymir.dev/api/mcp" }
  }
}
```

Then run `/mcp` (CLI) or open the MCP manager (IDE) and Authenticate. The workflow skills ship as a bundled plugin: clone this repo and copy `plugins/antigravity/` into `~/.gemini/config/plugins/` (global) or `.agents/plugins/` at your workspace root. The bundled `mcp_config.json` also includes a `mymir-local` server for self-host.

> **Gemini CLI users:** Antigravity replaces Gemini CLI (consumer access ends 2026-06-18). Run `agy plugin import gemini` to migrate, then use the Antigravity setup above.

---

## Self-host / contribute

Self-hosting is free under AGPL-3.0. You run the Mymir server yourself and point the plugin's **`mymir-local`** server at it, no env vars required.

You need [Bun](https://bun.sh) (v1.0+) and [Docker](https://docs.docker.com/get-docker/) for PostgreSQL. Linux, macOS, or Windows with WSL2.

```bash
git clone git@github.com:FrkAk/mymir.git
cd mymir
bun install --production
cp .env.local.example .env.local
```

Fill in `.env.local` by following the numbered steps at the top of `.env.local.example`. Then bring up Postgres, build, start, and open [localhost:3000](http://localhost:3000):

```bash
bun run db:setup
bun run build
bun run start
```

Install the plugin for your agent as above, but select the **`mymir-local`** server (it points at `http://localhost:3000/api/mcp`). Advanced self-hosters on a custom domain can set `MYMIR_URL` to repoint the default `mymir` server in Claude Code; Codex and Cursor read a hardcoded hosted URL, so edit their `mcp.json` directly if you need a custom domain.

Contributors install from the local checkout: `claude plugin marketplace add ./plugins/claude-code` (Claude Code), `codex plugin marketplace add ./plugins` (Codex), or copy `plugins/cursor` into `~/.cursor/plugins/local/`. Shared skills live in `plugins/claude-code/` (canonical); after editing them run `bun run sync:plugins` to regenerate every brand's copy (`bun run check:plugins` is CI-enforced).

---

## What gets installed

All four plugins bundle the shared components:

| Component | What it does |
| --- | --- |
| **6 MCP tools** | `mymir_project`, `mymir_task`, `mymir_edge`, `mymir_query`, `mymir_context`, `mymir_analyze` |
| **`/mymir` skill** | Auto-invokes when conversation matches project planning; routes to inline workflows or hands off to a deep-mode workflow when needed |
| **Brainstorm workflow** | Explore and shape a project idea through structured conversation |
| **Onboarding workflow** | Reverse-engineer an existing codebase into a task graph with shipped work recorded as `done` |
| **Decompose workflow** | Break a project brief into a dependency graph |
| **Manage workflow** | Strategic CTO-mode review: rebalance the graph, audit dependencies, prune orphans, consolidate categories |

In Codex, Cursor, and Antigravity each workflow is a skill invoked by slash command. In Claude Code each is also available as a dispatchable agent (via the Task tool) so the main `/mymir` skill can hand off work in a clean per-agent context.

**Claude Code additionally bundles:**

| Component | What it does |
| --- | --- |
| **`/mymir:composer` skill** | End-to-end task orchestrator. Picks the highest-value ready task (or one named ref), drives it through research → plan → implement → propagate via three dispatched subagents per task in clean per-phase contexts, loops until queue empty or user stops. Requires `/goal` harness for backlog mode (composer emits it on first turn; user pastes). |
| **Composer subagents** | `mymir:composer-researcher` gathers grounded context and refines the task; `mymir:composer-planner` writes the unabridged implementation plan; `mymir:composer-implementer` ships the code, opens a PR, and marks the task done. |
| **`mymir:decompose-task` agent** | Splits an existing oversize task in an active project into 2 to N children, rewires every dependency edge touching the parent, cancels the parent with rationale citing the children. Composer's oversize handler routes here. |
| **`mymir:decompose-feature` agent** | Adds a new feature or capability cluster to an active project. Reuses existing categories and tag vocabulary; creates 5 to 20 tasks plus internal and integration edges. |

(Composer depends on a subagent dispatch primitive for clean per-phase contexts and tool-restriction enforcement. Codex, Cursor, and Antigravity do not yet have an equivalent, so composer is Claude Code only for now.)

---

## How it runs

Mymir ships as a Next.js web app plus vendor-native plugins for Claude Code, Codex, Cursor, and Antigravity. Each plugin bundles 6 MCP tools, the four core workflows (brainstorm, onboarding, decompose, manage), and a `/mymir` skill that auto-invokes when you talk about projects, tasks, or planning. Claude Code adds end-to-end task orchestration via `/mymir:composer` plus `decompose-task` and `decompose-feature` for surgical decomposition within active projects. You don't call tools manually, you just talk.

**Three entry paths, one graph.**

*No project yet.* The brainstorm agent shapes the idea with you, then decompose breaks it into a task graph:

```text
❯ I want to build a real-time dashboard for server metrics
```

*Existing codebase, no tracking yet.* Onboarding reverse-engineers a graph from the code and git history, gated on your approval before anything is written:

```text
❯ Onboard this existing codebase
```

*Ongoing project.* The `/mymir` skill detects the repo and picks up where you left off:

```text
❯ What's the status of the project?
```

**Skip the context briefing.** Name a task or ask what's next. Mymir delivers the right bundle for that task's state, so you don't write "here's what you need to know" prompts yourself:

```text
❯ What should I work on next?
❯ Plan and implement MYMR-101
```

**Add and refine mid-flow.** Spot something missing, describe it, and push back until it's right:

```text
❯ Add a task for an onboarding agent that records shipped work as done tasks. Relate it to the codex/antigravity support task.
```

```text
❯ Priority is urgent, draft ACs are enough, and monorepo detection should ask the user.
```

**Drive end-to-end (Claude Code).** Once a project is active and tasks are ready, composer can take over. Pick the next task off the critical path, research it in context, plan it, implement it, open the PR, propagate the result, and loop:

```text
❯ /mymir:composer
```

Or take one specific task all the way to a PR:

```text
❯ /mymir:composer MYMR-101
```

Composer dispatches three subagents per task in clean per-phase contexts (researcher → planner → implementer). The orchestrator stays out of the work itself and only picks tasks, hands off, and propagates.

**Tune in the UI.** Inspect edges, read execution records, and edit descriptions, ACs, tags, or dependencies directly. The agent loop and the UI write to the same store, so edits land by the next tool call.

---

## How it works

Instead of docs, wikis, or messy markdown files, Mymir treats project context as a live knowledge base agents can reason from.

We built Mymir around two core concepts:

**Context network.** A living map of your project that captures not just what was built, but why decisions were made, what was tried and abandoned, and how different parts of the codebase relate to each other.

**Context retrieval interface.** Four context shapes, one per job. Each is arranged by U-shaped attention (highest-recall content at the start and end) so what matters most lands where LLMs read best:

| Shape | For | What's in it |
| --- | --- | --- |
| `summary` | Quick lookup | Title, status, edge counts |
| `working` | Refining or reviewing a task | Criteria, decisions, 1-hop neighbors |
| `planning` | Writing an implementation plan | Project brief, prerequisites, upstream execution records, downstream specs |
| `agent` | Coding the task | Implementation plan, multi-hop upstream execution records, file paths, acceptance criteria |

Together, they don't just inform your agent, they drive it. Mymir manages the full lifecycle: **Brainstorm > Decompose > Refine > Plan > Execute > Track**.

Describe your idea and Mymir decomposes it into tasks with dependency edges, determines what's ready to plan or implement, and hands your agent the exact context it needs for that stage. When a task is plannable, your agent gets the spec, prerequisites, and related work. When it's ready to implement, your agent gets the full execution context: upstream decisions, file paths, and acceptance criteria.

The agent moves from task to task with the right context at every step, no manual handoff required.

*We're building Mymir using Mymir, so everything described here is something we're living in real time.*

---

## How it looks

The web UI has two modes: **Structure** and **Graph**.

Structure mode puts your task list on the left and a detail panel on the right. You refine specs, track progress, and review execution records without switching views.

![Structure view](assets/projectview.png)

Graph mode overlays the context network so you can see how tasks, decisions, and dependencies connect while still working in the detail panel.

![Graph view](assets/graphview.png)

Zoom out and the full graph renders your entire context network. Clusters, bottlenecks, and orphaned work become obvious at a glance.

![Full graph](assets/graphonlyview_light.png)

---

## What's coming

We're working on a hosted version for those who want the full experience without the setup. Run from anywhere, access your team's projects, collaborate across sessions. Privacy is a core value, which is why it's taking longer than usual to get right.

The hosted version will be a paid service. We can't bear the infrastructure costs on our own, and we'd rather be upfront about that than pretend otherwise. Self-hosted remains free and always will.

---

## Why open source

We believe everyone should have access to tools that help them build better things. Open source is how we make that real.

It also means we ship faster. Community contributions, bug reports, and ideas make Mymir better for everyone. If you care about better infrastructure for agent-driven development, come build with us.

---

## Stack

Next.js 16, TypeScript 6, React 19, PostgreSQL, Drizzle ORM, Tailwind CSS v4, Motion

---

## Stargazers

<a href="https://www.star-history.com/?repos=FrkAk%2Fmymir&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=FrkAk/mymir&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=FrkAk/mymir&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=FrkAk/mymir&type=date&legend=top-left" />
 </picture>
</a>

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and PR guidelines.

## License

Mymir is licensed under [AGPL-3.0](LICENSE). A commercial license is also available, see [LICENSING.md](LICENSING.md) for details.
