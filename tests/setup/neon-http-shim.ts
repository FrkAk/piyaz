import postgres from "postgres";
import { neonConfig } from "@neondatabase/serverless";

/**
 * One captured neon-http request: the SQL batch the `@neondatabase/serverless`
 * client serialized, plus the headers that carry the transaction options.
 */
export type CapturedNeonRequest = {
  /** Endpoint URL the client targeted. */
  url: string;
  /** Plain header object the client built (`Neon-Batch-*`, connection string). */
  headers: Record<string, string>;
  /** Serialized statements: one for a single query, many for a batch. */
  queries: { query: string; params: unknown[] }[];
};

/** Handle returned by {@link installNeonHttpShim}. */
export type NeonHttpShim = {
  /** Every request the shim served, in arrival order. */
  requests: CapturedNeonRequest[];
  /** Restore `neonConfig.fetchFunction` so later suites use real fetch. */
  uninstall: () => void;
};

/** Wire shape of one query inside the neon-http request body. */
type WireQuery = { query: string; params: unknown[] };

/** Result row format postgres-js raw mode returns (text bytes or SQL NULL). */
type RawRow = (Buffer | null)[];

/** Column metadata postgres-js attaches to a result. */
type RawColumns = { name: string; type: number }[];

/** Result object shape the neon-http client parses per statement. */
type WireResult = {
  command: string;
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  rows: (string | null)[][];
  rowAsArray: boolean;
};

/** Process-wide postgres-js clients keyed by connection string. */
const shimClients = new Map<string, ReturnType<typeof postgres>>();

/**
 * Resolve (and cache) a postgres-js client for the connection string the
 * neon client put in the `Neon-Connection-String` header, so the shim
 * executes under the exact role the production code targeted.
 *
 * @param connectionString - Role-bearing URL from the request headers.
 * @returns Cached single-connection postgres-js client.
 */
function clientFor(connectionString: string): ReturnType<typeof postgres> {
  let client = shimClients.get(connectionString);
  if (!client) {
    client = postgres(connectionString, {
      max: 1,
      idle_timeout: 30,
      onnotice: () => undefined,
    });
    shimClients.set(connectionString, client);
  }
  return client;
}

/**
 * Translate the `Neon-Batch-*` headers into a postgres-js `begin` options
 * string (e.g. `isolation level read committed read only`).
 *
 * @param headers - Request headers from the neon client.
 * @returns Options string for `sql.begin`, possibly empty.
 */
function beginOptions(headers: Record<string, string>): string {
  const parts: string[] = [];
  const isolation = headers["Neon-Batch-Isolation-Level"];
  if (isolation) {
    parts.push(
      `isolation level ${isolation.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`,
    );
  }
  const readOnly = headers["Neon-Batch-Read-Only"];
  if (readOnly === "true") parts.push("read only");
  return parts.join(" ");
}

/**
 * Minimal structural surface of a postgres-js client or transaction handle
 * that {@link runWireQuery} needs. Call sites cast the concrete handle in
 * because postgres-js's `unsafe` parameter types are narrower than the
 * untyped wire params.
 */
type WireHandle = {
  unsafe: (q: string, p: unknown[]) => { raw: () => Promise<RawRow[]> };
};

/**
 * Execute one wire query on the given handle and shape the result like the
 * Neon HTTP API does with `Neon-Raw-Text-Output` + `Neon-Array-Mode`: rows
 * as arrays of text-format values (`null` for SQL NULL) plus `fields`
 * carrying the type OIDs the client's pg-types parsers key on.
 *
 * @param handle - postgres-js client or transaction handle.
 * @param wire - Serialized query + params from the request body.
 * @returns Result object in the Neon wire shape.
 */
async function runWireQuery(
  handle: WireHandle,
  wire: WireQuery,
): Promise<WireResult> {
  const raw = await handle.unsafe(wire.query, wire.params).raw();
  const meta = raw as unknown as {
    columns?: RawColumns;
    command?: string;
    count?: number;
  };
  return {
    command: meta.command ?? "SELECT",
    rowCount: meta.count ?? raw.length,
    fields: (meta.columns ?? []).map((c) => ({
      name: c.name,
      dataTypeID: c.type,
    })),
    rows: raw.map((row) =>
      row.map((value) => (value === null ? null : value.toString("utf8"))),
    ),
    rowAsArray: true,
  };
}

/**
 * Build the minimal `Response`-shaped object the neon client reads
 * (`ok` / `status` / `json()` / `text()`).
 *
 * @param status - HTTP status code.
 * @param payload - JSON body.
 * @returns Response-shaped object.
 */
function shimResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/**
 * Point `neonConfig.fetchFunction` at an in-process implementation of the
 * Neon HTTP SQL API backed by the local test Postgres. Batches run inside
 * one real transaction honoring the `Neon-Batch-Isolation-Level` and
 * `Neon-Batch-Read-Only` headers, and values round-trip in Postgres text
 * format so the client's pg-types parsing behaves exactly as against Neon.
 *
 * Lets the production neon-http read path (driver, drizzle batch, RLS GUC
 * contract) run end-to-end against the RLS-provisioned test database with
 * no real Neon endpoint.
 *
 * @returns Capture handle; call `uninstall()` when the suite finishes.
 */
export function installNeonHttpShim(): NeonHttpShim {
  const requests: CapturedNeonRequest[] = [];

  neonConfig.fetchFunction = async (
    url: string,
    init: { body: string; headers: Record<string, string> },
  ) => {
    const headers = init.headers;
    const body = JSON.parse(init.body) as { queries: WireQuery[] } | WireQuery;
    const isBatch = "queries" in body;
    const queries = isBatch ? body.queries : [body];
    requests.push({ url, headers, queries });

    const connectionString = headers["Neon-Connection-String"];
    const client = clientFor(connectionString);
    try {
      if (isBatch) {
        const options = beginOptions(headers);
        const run = async (tx: unknown) => {
          const handle = tx as WireHandle;
          const results: WireResult[] = [];
          for (const wire of queries) {
            results.push(await runWireQuery(handle, wire));
          }
          return results;
        };
        const results = await (options
          ? client.begin(options, run)
          : client.begin(run));
        return shimResponse(200, { results });
      }
      return shimResponse(
        200,
        await runWireQuery(client as unknown as WireHandle, queries[0]),
      );
    } catch (e) {
      const err = e as { message: string; code?: string; severity?: string };
      return shimResponse(400, {
        message: err.message,
        code: err.code,
        severity: err.severity,
      });
    }
  };

  return {
    requests,
    uninstall: () => {
      neonConfig.fetchFunction = undefined;
    },
  };
}
