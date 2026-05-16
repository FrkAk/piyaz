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
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db",
              message:
                "Application code must import from @/lib/data, not @/lib/db. The data layer is defined in lib/data/. Boundary documented in docs/superpowers/plans/2026-05-06-db-access-rework.md.",
            },
            {
              name: "@/lib/db/connection",
              message:
                "Application code must import from @/lib/data, not @/lib/db. The data layer is defined in lib/data/. Boundary documented in docs/superpowers/plans/2026-05-06-db-access-rework.md.",
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
