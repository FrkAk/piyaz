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
    ignores: ["lib/db/**", "tests/**"],
    plugins: { import: importPlugin },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='execute']",
          message:
            "Direct `.execute()` calls are forbidden. Add a named function in lib/db/raw/ and call it via executeRaw / executeRawDiscard.",
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
