import { readFileSync, existsSync } from "fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't auto-load .env.local — load it manually
const envPath = ".env.local";
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  }
}

// drizzle-kit migrate/push runs DDL — needs a role that owns the schema or has
// BYPASSRLS + CREATE. Persistent DBs (dev/prod CI) pass the dedicated `migrator`
// role via DATABASE_MIGRATION_URL; local throwaway containers reuse
// service_role's DATABASE_SERVICE_ROLE_URL. Falls back to DATABASE_URL for
// pre-RLS single-role setups.
const pushUrl =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.DATABASE_SERVICE_ROLE_URL ??
  process.env.DATABASE_URL;

if (!pushUrl) {
  throw new Error(
    "DATABASE_MIGRATION_URL (or DATABASE_SERVICE_ROLE_URL / DATABASE_URL) is required for drizzle-kit",
  );
}

export default defineConfig({
  out: "./drizzle",
  schema: ["./lib/db/schema.ts"],
  dialect: "postgresql",
  schemaFilter: ["public"],
  // Pin the migration journal location so dev, prod, and CI agree. These are
  // the PostgreSQL defaults; pinning makes the `migrate` mark-applied step and
  // the drift gate deterministic across environments.
  migrations: {
    schema: "drizzle",
    table: "__drizzle_migrations",
  },
  dbCredentials: {
    url: pushUrl,
  },
});
