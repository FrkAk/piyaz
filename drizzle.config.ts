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

// `drizzle-kit push` runs DDL (CREATE TABLE / ALTER TABLE / etc.) and needs
// the BYPASSRLS + CREATE-on-schema-public role. The runtime `DATABASE_URL`
// points at `app_user` (no CREATE, no BYPASSRLS), so push must connect via
// `DATABASE_SERVICE_ROLE_URL`. Falls back to `DATABASE_URL` for legacy
// single-role setups (pre-MYMR-151 clones, or environments where the
// runtime role still carries BYPASSRLS).
const pushUrl =
  process.env.DATABASE_SERVICE_ROLE_URL ?? process.env.DATABASE_URL;

if (!pushUrl) {
  throw new Error(
    "DATABASE_SERVICE_ROLE_URL (or DATABASE_URL) is required for drizzle-kit",
  );
}

export default defineConfig({
  out: "./drizzle",
  schema: ["./lib/db/schema.ts"],
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: {
    url: pushUrl,
  },
});
