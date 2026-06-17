# Contributing to Mymir

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
