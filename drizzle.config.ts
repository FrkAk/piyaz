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

// drizzle-kit push runs DDL — needs BYPASSRLS + CREATE on schema public.
// Falls back to DATABASE_URL for pre-RLS single-role setups.
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
