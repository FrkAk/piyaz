import { createRequire } from "module";

const require = createRequire(import.meta.url);

const baseConfig = require("eslint-config-next/core-web-vitals");
const tsConfig = require("eslint-config-next/typescript");
const importPlugin = require("eslint-plugin-import");

// Files permitted to import directly from @/lib/db.
// Permanent: data layer, driver internals, Better-Auth wiring,
// drizzle-kit config, and test code.
const DB_IMPORT_ALLOWLIST = [
  "lib/data/**/*.{ts,tsx}",
  "lib/db/**/*.{ts,tsx}",
  "lib/auth.ts",
  "drizzle.config.ts",
  "tests/**/*.{ts,tsx}",
];

const eslintConfig = [
  ...baseConfig,
  ...tsConfig,
  {
    // Generated outputs: wrangler env types and OpenNext / Wrangler build
    // artifacts. Linting these adds no value and surfaces noise from
    // generated code. `.claude/**` excludes nested git worktrees: they are
    // separate checkouts that lint themselves, and the root-relative exempt
    // globs below (e.g. `lib/data/account.ts`) do not match their prefixed
    // paths, so scanning them re-flags already-audited RLS bypass sites.
    ignores: [
      "cloudflare-env.d.ts",
      ".open-next/**",
      ".wrangler/**",
      ".claude/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    ignores: [
      "lib/db/**",
      "tests/**",
      "lib/data/membership.ts",
      "lib/data/oauth-session.ts",
      "lib/data/account.ts",
    ],
    plugins: { import: importPlugin },
    rules: {
      // The name-based selectors below can be defeated by aliasing
      // (`const x = db; x.transaction(...)`), destructuring
      // (`const { transaction } = db; transaction(...)`), or renamed
      // imports (`import { db as foo } from "@/lib/db"`). They catch
      // the common case and serve as documentation. The primary runtime
      // defense is the `Conn` brand in lib/db/raw.ts (which is
      // `AppUserConn | RlsTx`, NOT `ServiceRoleConn` or a bare `AppDb`).
      // Any data-ring helper typed against `Conn` rejects unbranded
      // handles at compile time — see tests/security/conn-brand.test.ts.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='execute']",
          message:
            "Direct `.execute()` calls are forbidden. Add a named function in lib/db/raw/ and call it via executeRaw / executeRawDiscard.",
        },
        {
          selector:
            "CallExpression[callee.object.name='db'][callee.property.name='transaction']",
          message:
            "Bare db.transaction() opens a raw Postgres transaction without setting the app.user_id GUC. Use withUserContext(userId, async tx => ...) from @/lib/db/rls instead. If this is a documented exempt site, add the file to the ignores list in eslint.config.mjs.",
        },
        {
          selector:
            "CallExpression[callee.object.name='db'][callee.property.name=/^(select|insert|update|delete)$/]",
          message:
            "Bare db.select/insert/update/delete bypasses RLS — under app_user with no GUC, the query default-denies and silently returns empty (or wrong-tenant) data. Wrap the call in withUserContext(userId, async tx => tx.<verb>(...)) from @/lib/db/rls. If this is a documented exempt site, add the file to the ignores list in eslint.config.mjs.",
        },
        {
          selector:
            "CallExpression[callee.object.name='serviceRoleDb'][callee.property.name='transaction']",
          message:
            "serviceRoleDb.transaction() is BYPASSRLS. Allowed sites: lib/data/account.ts:clearOrgMembershipArtifacts and lib/data/oauth-session.ts. If you need a new bypass site, audit whether a SECURITY DEFINER function in docker/rls-functions.sql can replace it.",
        },
        {
          selector:
            "CallExpression[callee.object.name='serviceRoleDb'][callee.property.name=/^(select|insert|update|delete)$/]",
          message:
            "serviceRoleDb.<verb> is BYPASSRLS. Allowed sites: lib/data/oauth-session.ts (oauth tables), lib/data/account.ts (clearOrgMembershipArtifacts), lib/data/membership.ts (admin lookups). Consider whether a SECURITY DEFINER function in docker/rls-functions.sql can replace this call site.",
        },
        {
          selector: "MemberExpression[object.name='db'][property.name='query']",
          message:
            "db.query.* is the Drizzle relational API and bypasses RLS the same way bare db.select does — under app_user with no GUC it default-denies silently. Use withUserContext(userId, async tx => tx.query.*) or, preferably, tx.select(...) from @/lib/db/rls.",
        },
        {
          selector: "CallExpression[callee.property.name='batch']",
          message:
            "Bare .batch() is reserved for the neon-http read driver: outside withUserContextRead(userId, (read) => [...statements]) from @/lib/db/rls it opens a batch transaction without the app.user_id GUC and RLS silently returns empty (or wrong-tenant) data. If this is not a database batch, add the file to the ignores list in eslint.config.mjs.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db",
              message:
                "Application code must import from @/lib/data, not @/lib/db. The data layer is defined in lib/data/.",
            },
            {
              name: "@/lib/db/connection",
              message:
                "Application code must import from @/lib/data, not @/lib/db. The data layer is defined in lib/data/.",
            },
            {
              name: "@cloudflare/workers-types",
              message:
                "Importing @cloudflare/workers-types pulls its ambient declarations globally and clobbers DOM Request/Response types, breaking unrelated tests. Declare minimal local type stubs in the workers-only file that needs them (see lib/realtime/broker-do.ts for the pattern).",
            },
            {
              name: "drizzle-orm/neon-http",
              message:
                "The neon-http driver is wired per role in lib/db/_driver.workers.ts and consumed through withUserContextRead. Constructing an ad-hoc HTTP client skips the per-batch app.user_id GUC and the READ ONLY transaction defaults.",
            },
            {
              name: "@neondatabase/serverless",
              message:
                "Neon driver construction belongs to lib/db/_driver.workers.ts; ad-hoc clients skip the request-scoped lifecycle and the RLS read-batch contract.",
            },
          ],
        },
      ],
    },
  },
  // Allow the data layer and security gates to import from @/lib/db directly.
  {
    files: DB_IMPORT_ALLOWLIST,
    rules: {
      "no-restricted-imports": "off",
    },
  },
];

export default eslintConfig;
