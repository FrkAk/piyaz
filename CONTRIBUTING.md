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

4. Start Postgres and push the schema:

   ```sh
   bun run db:setup
   ```

5. Start the development server:

   ```sh
   bun run dev
   ```

## Database changes

The `public` schema is owned by Drizzle (`lib/db/schema.ts` generates `drizzle/`). The `piyaz_auth` schema, the three Postgres roles, grants, and RLS policies/functions are hand-written SQL under `docker/`.

Persistent databases (dev and production) use versioned migrations, never `push`:

- `bun run db:generate` writes a migration from `lib/db/schema.ts` changes.
- `bun run db:migrate` applies pending migrations as `service_role` over the direct (unpooled) Neon host.

`db:push` is only for throwaway databases (the local Docker container via `db:setup`, and the CI test container). It force-syncs and can drop columns, so it never runs against a persistent database. CI fails a PR when `db:generate` produces an uncommitted migration, so a `schema.ts` change cannot merge without its migration.

### Adding a table

Ship each table's access control in the same migration as its `CREATE TABLE`:

1. Add the table to `lib/db/schema.ts` with `.enableRLS()`, then run `bun run db:generate`. The generated file already emits `ENABLE ROW LEVEL SECURITY`.
2. Hand-append to that generated migration file:
   - `GRANT SELECT, INSERT, UPDATE, DELETE ON "<table>" TO app_user, service_role;` (and `GRANT USAGE, SELECT ON "<seq>" TO app_user, service_role;` for any serial column).
   - `ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;`
   - the tenant-scoping `CREATE POLICY ... TO app_user`.
3. Mirror the same `FORCE` + policy into `docker/rls-policies.sql` so the push-based test and local containers get them too (`docker/grants.sql` already covers grants via `GRANT ... ON ALL TABLES`).
4. Commit `schema.ts`, the migration, and the `docker/` change together.

Grants and policies are explicit per table on purpose. `ALTER DEFAULT PRIVILEGES` is deliberately not used on `public`: it would grant a new table to `app_user` in the window between `CREATE TABLE` and its policy attach, a cross-tenant read window. A missing grant is a loud runtime failure; a missing RLS attach is caught by `tests/db/rls-coverage.test.ts`.

## Before submitting a PR

Run all checks locally:

```sh
bun run lint
bun run typecheck
```

Both must pass. CI will run them automatically on your PR.

## PR process

- Create a feature branch from `main`.
- Keep changes focused. One concern per PR.
- Use the PR template and fill in all sections.
- All PRs require a review and must pass CI before merging.
- Squash merge is the only merge strategy.

## Commit messages

Format: `<type>: <short description>`

Examples: `fix: resolve rate limiter timing on 429`, `feat: add task dependency visualization`

## Licensing

By submitting a pull request, you agree that your contribution may be distributed under both the AGPL 3.0 and the commercial license. See [LICENSING.md](LICENSING.md) for details.
