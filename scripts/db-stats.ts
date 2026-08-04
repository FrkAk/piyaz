/**
 * Read-only operational analytics over pg_stat_statements: per-class volume
 * (read / write / control / other), top-N reads and writes by total time and
 * by calls, and the stats_reset observation window (Neon clears the view on
 * every compute suspend, so the window line is load-bearing).
 *
 * Reads DATABASE_OWNER_URL — the same trusted-local-shell-only contract as
 * scripts/apply-owner-rls.ts; Worker runtime roles have no stats access.
 * Privacy: query text is printed only for read/write DML, which
 * pg_stat_statements normalizes ($1 placeholders — no bind values, no tenant
 * data). control/other statements are aggregate-only because utility
 * statements are NOT normalized (`SET app.user_id = '<uuid>'` carries a real
 * user id) and track_utility cannot be disabled on Neon. Never paste this
 * report into the public repo.
 *
 * Usage: `bun run db:stats [--top <n>]`.
 */
import postgres from "postgres";

/** Statements shown per section when `--top` is not given. */
const DEFAULT_TOP_N = 20;

/** Display width for the normalized query column. */
const QUERY_DISPLAY_WIDTH = 100;

/**
 * SQL CASE fragment classing every pg_stat_statements row. `\y` is the
 * Postgres regex word boundary. Order matters: transaction/session control
 * first, then plain DML writes, then writing CTEs, then reads; everything
 * else (DDL, maintenance, other utility) falls through to 'other'.
 */
const CLASS_CASE = `CASE
  WHEN query ~* '^\\s*(begin|commit|rollback|set|reset|show|deallocate|discard|listen|unlisten|savepoint|release|prepare|fetch|close)\\y' THEN 'control'
  WHEN query ~* '^\\s*(insert|update|delete|merge)\\y' THEN 'write'
  WHEN query ~* '^\\s*with\\y' AND query ~* '\\y(insert|update|delete|merge)\\y' THEN 'write'
  WHEN query ~* '^\\s*(select|values|table|with)\\y' THEN 'read'
  ELSE 'other'
END`;

/** Scope every query to the connected database's statements. */
const DBID_FILTER = `dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;

/** One row of the per-class aggregate. */
export interface ClassSummaryRow {
  statement_class: string;
  statements: string;
  calls: string;
  total_exec_time: number;
}

/** One normalized statement row from pg_stat_statements. */
export interface StatementRow {
  calls: string;
  total_exec_time: number;
  mean_exec_time: number;
  rows: string;
  shared_blks_hit: string;
  shared_blks_read: string;
  shared_blks_dirtied: string;
  temp_blks_read: string;
  temp_blks_written: string;
  wal_bytes: string;
  query: string;
}

/** Everything the report renders, fetched in one connection. */
export interface DbStatsReport {
  statsReset: Date | null;
  classSummary: ClassSummaryRow[];
  readsByTime: StatementRow[];
  readsByCalls: StatementRow[];
  writesByTime: StatementRow[];
  writesByCalls: StatementRow[];
}

/**
 * Collapse whitespace runs to single spaces and truncate with an ellipsis.
 *
 * @param query - Normalized statement text.
 * @param width - Maximum output length including the ellipsis.
 * @returns Single-line text no longer than `width`.
 */
export function sanitizeQueryText(
  query: string,
  width = QUERY_DISPLAY_WIDTH,
): string {
  const collapsed = query.replace(/\s+/g, " ").trim();
  if (collapsed.length <= width) return collapsed;
  return `${collapsed.slice(0, width - 1)}…`;
}

/**
 * Format milliseconds with two decimals.
 *
 * @param ms - Millisecond value.
 * @returns Fixed-point string, e.g. `12.34`.
 */
export function formatMs(ms: number): string {
  return ms.toFixed(2);
}

/**
 * Format a byte count with a binary unit suffix.
 *
 * @param value - Byte count (string when the driver returns int8/numeric).
 * @returns Humanized size, e.g. `1.5 MiB`.
 */
export function formatBytes(value: string | number): string {
  let n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  for (const unit of ["B", "KiB", "MiB", "GiB"]) {
    if (n < 1024)
      return unit === "B" ? `${n} ${unit}` : `${n.toFixed(1)} ${unit}`;
    n /= 1024;
  }
  return `${n.toFixed(1)} TiB`;
}

/**
 * Render rows as a padded text table.
 *
 * @param headers - Column headers.
 * @param rows - Cell values, one array per row.
 * @param leftAligned - Indexes of left-aligned columns (rest right-align).
 * @returns Multi-line table string.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  leftAligned: number[] = [],
): string {
  const left = new Set(leftAligned);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) =>
        left.has(i) ? cell.padEnd(widths[i]) : cell.padStart(widths[i]),
      )
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/**
 * Render the per-class aggregate. Never includes query text: this is the
 * only surface where control/other statements appear.
 *
 * @param rows - Class summary rows.
 * @returns Table string, or a placeholder when nothing was recorded.
 */
export function formatClassSummary(rows: ClassSummaryRow[]): string {
  if (rows.length === 0) return "(no statements recorded)";
  return renderTable(
    ["class", "statements", "calls", "total ms"],
    rows.map((r) => [
      r.statement_class,
      r.statements,
      r.calls,
      formatMs(r.total_exec_time),
    ]),
    [0],
  );
}

/**
 * Render one top-N statement table (reads or writes only).
 *
 * @param rows - Statement rows.
 * @returns Table string, or a placeholder when the section is empty.
 */
export function renderStatementsTable(rows: StatementRow[]): string {
  if (rows.length === 0) return "(no statements recorded)";
  return renderTable(
    [
      "calls",
      "total ms",
      "mean ms",
      "rows",
      "blk hit",
      "blk read",
      "blk dirty",
      "tmp rd",
      "tmp wr",
      "wal",
      "query",
    ],
    rows.map((r) => [
      r.calls,
      formatMs(r.total_exec_time),
      formatMs(r.mean_exec_time),
      r.rows,
      r.shared_blks_hit,
      r.shared_blks_read,
      r.shared_blks_dirtied,
      r.temp_blks_read,
      r.temp_blks_written,
      formatBytes(r.wal_bytes),
      sanitizeQueryText(r.query),
    ]),
    [10],
  );
}

/**
 * Assemble the full report text.
 *
 * @param report - Fetched report data.
 * @returns Multi-section report string.
 */
export function formatDbStatsReport(report: DbStatsReport): string {
  const window = report.statsReset
    ? report.statsReset.toISOString()
    : "unknown (stats_reset unavailable)";
  const sections = [
    `pg_stat_statements report (window since ${window})`,
    `statement classes\n${formatClassSummary(report.classSummary)}`,
    `top reads by total time\n${renderStatementsTable(report.readsByTime)}`,
    `top reads by calls\n${renderStatementsTable(report.readsByCalls)}`,
    `top writes by total time\n${renderStatementsTable(report.writesByTime)}`,
    `top writes by calls\n${renderStatementsTable(report.writesByCalls)}`,
  ];
  return sections.join("\n\n");
}

/**
 * Read the owner connection string from the environment.
 *
 * @returns The database-owner DIRECT connection string.
 * @throws Error when DATABASE_OWNER_URL is unset.
 */
function ownerUrl(): string {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    throw new Error(
      "DATABASE_OWNER_URL is required for the stats report (database owner role, trusted local shell only).",
    );
  }
  return url;
}

/**
 * Parse the `--top <n>` argument.
 *
 * @param argv - Process arguments after the script path.
 * @returns Statements per section (1..200).
 * @throws Error on a malformed or out-of-range value.
 */
function parseTopN(argv: string[]): number {
  const at = argv.indexOf("--top");
  if (at === -1) return DEFAULT_TOP_N;
  const n = Number(argv[at + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(
      `--top expects an integer between 1 and 200, got "${argv[at + 1]}"`,
    );
  }
  return n;
}

/**
 * Fetch one top-N statement list for a class and ordering.
 *
 * @param sql - Active owner client.
 * @param statementClass - `read` or `write`.
 * @param orderBy - `total_exec_time` or `calls`.
 * @param topN - Row cap.
 * @returns Statement rows.
 */
async function fetchTopStatements(
  sql: ReturnType<typeof postgres>,
  statementClass: "read" | "write",
  orderBy: "total_exec_time" | "calls",
  topN: number,
): Promise<StatementRow[]> {
  const rows = await sql.unsafe(
    `SELECT calls::text, total_exec_time, mean_exec_time, rows::text,
            shared_blks_hit::text, shared_blks_read::text, shared_blks_dirtied::text,
            temp_blks_read::text, temp_blks_written::text, wal_bytes::text,
            left(query, 400) AS query
     FROM extensions.pg_stat_statements
     WHERE ${DBID_FILTER} AND toplevel AND ${CLASS_CASE} = '${statementClass}'
     ORDER BY ${orderBy} DESC
     LIMIT $1`,
    [topN],
  );
  return rows as unknown as StatementRow[];
}

/**
 * Fetch everything the report renders.
 *
 * @param sql - Active owner client.
 * @param topN - Statements per top-N section.
 * @returns The report data.
 */
async function fetchReport(
  sql: ReturnType<typeof postgres>,
  topN: number,
): Promise<DbStatsReport> {
  const classSummary = (await sql.unsafe(
    `SELECT ${CLASS_CASE} AS statement_class,
            count(*)::text AS statements,
            sum(calls)::text AS calls,
            sum(total_exec_time) AS total_exec_time
     FROM extensions.pg_stat_statements
     WHERE ${DBID_FILTER}
     GROUP BY 1
     ORDER BY sum(total_exec_time) DESC`,
  )) as unknown as ClassSummaryRow[];
  const [info] = (await sql.unsafe(
    `SELECT stats_reset FROM extensions.pg_stat_statements_info`,
  )) as unknown as Array<{ stats_reset: Date | null }>;
  return {
    statsReset: info?.stats_reset ?? null,
    classSummary,
    readsByTime: await fetchTopStatements(sql, "read", "total_exec_time", topN),
    readsByCalls: await fetchTopStatements(sql, "read", "calls", topN),
    writesByTime: await fetchTopStatements(
      sql,
      "write",
      "total_exec_time",
      topN,
    ),
    writesByCalls: await fetchTopStatements(sql, "write", "calls", topN),
  };
}

/**
 * Map a query failure to an actionable remediation hint.
 *
 * @param err - Caught error.
 * @returns Hint line, or undefined for unrecognized failures.
 */
function failureHint(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code;
  if (message.includes("shared_preload_libraries")) {
    return "pg_stat_statements is installed but not preloaded. Self-host: docker-compose.yml sets shared_preload_libraries; restart the container (docker compose up -d).";
  }
  if (code === "42P01" || /pg_stat_statements.*does not exist/i.test(message)) {
    return "pg_stat_statements is not installed. Apply docker/extensions.sql: bun run db:rls (self-host) or bun run db:rls:owner (hosted).";
  }
  return undefined;
}

/**
 * Fetch and print the report.
 *
 * @throws Error when the environment or database is not ready.
 */
async function main(): Promise<void> {
  const topN = parseTopN(process.argv.slice(2));
  const sql = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
  try {
    console.log(formatDbStatsReport(await fetchReport(sql, topN)));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    const hint = failureHint(err);
    if (hint) console.error(`  - ${hint}`);
    process.exit(1);
  }
}
