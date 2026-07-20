import { sql, type SQL } from "drizzle-orm";

/**
 * The only sanctioned stamp for `updated_at` / `meta_updated_at` on the
 * conditional-GET validator tables (`projects`, `tasks`, `task_edges`,
 * `notes`).
 *
 * `clock_timestamp()` is row-write wall time. Unlike `now()` (transaction
 * start) it re-evaluates after a lock wait under READ COMMITTED, so a write
 * from a long-open transaction still lands above the validator MAX and can
 * never freeze a stale 304. Two stamps in one SET clause evaluate
 * independently and may differ by microseconds; nothing compares the two
 * clock columns to each other, and every read-back truncates to
 * milliseconds in the driver.
 *
 * @returns A fresh `clock_timestamp()` SQL fragment.
 */
export function dbClockStamp(): SQL<Date> {
  return sql`clock_timestamp()`;
}
