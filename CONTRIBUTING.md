# Contributing to Piyaz

## Prerequisites

| Dependency | Purpose |
| ---------- | ------- |
| [Bun](https://bun.sh) (v1.0+) | JavaScript runtime and package manager |
| [Docker](https://docs.docker.com/get-docker/) and Compose | Runs PostgreSQL for local development |

## Getting started

1. Fork and clone the repository.
2. Copy the environment template and fill in your keys:

   ```sh
   cp .env.local.example .env.local
   ```

3. Install dependencies:

   ```sh
   bun install
   ```

4. Start Postgres and apply the schema:

   ```sh
   bun run db:setup
   ```

5. Start the development server:

   ```sh
   bun run dev
   ```

## Database changes

The `public` schema is owned by Drizzle (`lib/db/schema.ts` generates `drizzle/`). The `piyaz_auth` schema, the three Postgres roles, grants, and RLS policies/functions are hand-written SQL under `docker/`.

A running instance holds real data, so schema changes ship as versioned migrations, never `push`:

- `bun run db:generate` writes a migration from `lib/db/schema.ts` changes.
- `bun run db:migrate` applies pending migrations to your database.

`db:push` is only for throwaway databases (the CI test container). It force-syncs and can drop columns, so it never runs against a database with real data. CI fails a PR when `db:generate` produces an uncommitted migration, so a `schema.ts` change cannot land without its migration.

### Adding a table

1. Add the table to `lib/db/schema.ts` with `.enableRLS()`, then run `bun run db:generate`. The generated migration emits `CREATE TABLE` and `ENABLE ROW LEVEL SECURITY`. Do not hand-edit the generated file.
2. Add the table's `ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;` and its tenant-scoping `CREATE POLICY ... TO app_user` to `docker/rls-policies.sql`.
3. Grants need no per-table edit: `docker/grants.sql` already covers public tables via `GRANT ... ON ALL TABLES IN SCHEMA public`.
4. Commit `schema.ts`, the generated migration, and the `docker/` change together.

`bun run db:rls` applies the grants and policies after `db:migrate`. They stay out of the generated migration on purpose: `drizzle-kit push` (used by the test container) drops `pgPolicy` `USING`/`WITH CHECK` clauses, so policy DDL is hand-written in `docker/rls-policies.sql`. `ALTER DEFAULT PRIVILEGES` is deliberately not used on `public`: it would grant a new table to `app_user` in the window between `CREATE TABLE` and its policy attach, a cross-tenant read window. A missing grant is a loud runtime failure; a missing RLS attach is caught by `tests/db/rls-coverage.test.ts`.

### Changing RLS helper functions

The `SECURITY DEFINER` functions in `docker/rls-functions.sql` (such as `current_user_org_ids`) are applied by `bun run db:rls`, not by `db:migrate` — several read `piyaz_auth` and are owned by the database owner. To change one: edit `docker/rls-functions.sql`, then run `bun run db:rls` (idempotent via `CREATE OR REPLACE`); never hand-edit a live database. Table, column, and index changes flow through `db:migrate`; grants and policies are applied by `db:rls`.

Migrations are roll-forward only (Drizzle has no down-migrations), so follow expand/contract: additive changes ship with the code that needs them; destructive cleanups (drop column/table) ship in a separate later change, keeping every upgrade roll-forward-safe.

## Before submitting a PR

Run all checks locally:

```sh
bun run lint
bun run typecheck
```

Both must pass. CI will run them automatically on your PR.

## Legal and compliance surface

`content/legal/*.md` and `lib/legal/versions.ts` are the legal surface for the hosted service. A PR that adds or renames a cookie or client-side storage key, collects new personal data, adds or swaps a third-party service, or changes how personal data flows must update the affected legal docs in the same PR, and say so in the PR template's "Compliance impact" section. When a document's text changes, bump its `LEGAL_VERSIONS` entry and the doc's "Last updated" date together; a bump re-offers the document to every user through the re-consent gate, so never bump without a text change. The cookie inventory in the privacy policy must stay in sync with the cookies the app actually sets.

## PR process

- Create a feature branch from `main`.
- Keep changes focused. One concern per PR.
- Use the PR template and fill in all sections.
- The PR title must follow Conventional Commits (`<type>: <description>`); CI rejects titles that don't.
- All PRs require a review and must pass CI before merging.
- Squash merge is the only merge strategy.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org): `<type>: <short description>`. Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `style`, `build`, `revert`.

Examples: `fix: resolve rate limiter timing on 429`, `feat: add task dependency visualization`

## Licensing

By submitting a pull request, you agree that your contribution may be distributed under both the AGPL 3.0 and the commercial license. See [LICENSING.md](LICENSING.md) for details.
