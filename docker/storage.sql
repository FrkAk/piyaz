-- Physical (TOAST) column compression for public.*. Drizzle models only the
-- logical schema (drizzle-orm@0.45 / drizzle-kit@0.31 expose no per-column
-- compression API), so this physical DDL lives in the post-migrate apply path
-- rather than hand-edited into a generated migration. Applied by the migration
-- role (which owns public) right after db:migrate, idempotently on every
-- deploy, and asserted by scripts/verify-rls.ts.
--
-- lz4 decompresses several times faster than the default pglz at a comparable
-- ratio, cutting detoast CPU and storage/WAL/backup bytes on the large note
-- columns. Client egress is unaffected: values cross the wire decompressed.
ALTER TABLE "notes" ALTER COLUMN "body" SET COMPRESSION lz4;
ALTER TABLE "notes" ALTER COLUMN "search_tsv" SET COMPRESSION lz4;

-- note_revisions stores a full body snapshot per edit — the largest-growing text
-- store in the schema over a note's lifetime. lz4 on body cuts detoast CPU on
-- every rollback/audit read and storage/WAL growth per snapshot, same rationale
-- as notes.body. title is left on the default to match notes.title (small, not
-- worth compressing).
ALTER TABLE "note_revisions" ALTER COLUMN "body" SET COMPRESSION lz4;
