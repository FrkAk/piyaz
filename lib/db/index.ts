import "server-only";

import { appDb, serviceRoleDb as _serviceRoleDb } from "./connection";

/**
 * Application Drizzle client.
 *
 * @see ./connection.ts for driver selection and lazy-init details.
 */
export const db = appDb;

/**
 * BYPASSRLS Drizzle client. Wired against `DATABASE_SERVICE_ROLE_URL`.
 *
 * @see ./connection.ts for the canonical inventory of bypass call sites.
 */
export const serviceRoleDb = _serviceRoleDb;

/**
 * A drizzle client or a transaction handle. Re-exported here so the
 * `lib/data/` ring imports both `db` and `Conn` from a single module.
 *
 * @see ./raw.ts for the canonical definition.
 */
export type { Conn } from "./raw";
