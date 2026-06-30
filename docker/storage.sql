-- Physical (TOAST) column compression for public.*. Drizzle models only the
-- logical schema (drizzle-orm@0.45 / drizzle-kit@0.31 expose no per-column
-- compression API), so this physical DDL lives in the post-migrate apply path
-- rather than hand-edited into a generated migration. Applied by the migration
-- role (which owns public) right after db:migrate, idempotently on every
-- deploy, and asserted by scripts/verify-rls.ts.
--
-- lz4 decompresses several times faster than the default pglz at a comparable
-- ratio, cutting CPU and egress on the large note columns.
ALTER TABLE "notes" ALTER COLUMN "body" SET COMPRESSION lz4;
ALTER TABLE "notes" ALTER COLUMN "search_tsv" SET COMPRESSION lz4;
