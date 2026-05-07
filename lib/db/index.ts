import { appDb } from "./connection";

/**
 * Application Drizzle client.
 *
 * @see ./connection.ts for driver selection and lazy-init details.
 */
export const db = appDb;

/**
 * A drizzle client or a transaction handle. Re-exported here so the
 * `lib/data/` ring imports both `db` and `Conn` from a single module.
 *
 * @see ./raw.ts for the canonical definition.
 */
export type { Conn } from "./raw";
