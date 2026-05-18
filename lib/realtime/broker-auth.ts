/**
 * HMAC-SHA256 signing envelope for the `MymirBroker` Durable Object RPC
 * surface. Authenticates every fetch the Workers broker adapter sends to
 * the DO so callers cannot spoof a `userId` or fabricate dispatches even
 * if they obtain the `MYMIR_BROKER` binding through some other path.
 *
 * Signing inputs (canonical string):
 *
 *   `${method}.${pathname}.${ts}.${nonce}.${bodyHashHex}.${userId ?? ""}`
 *
 *   - `method` — uppercase HTTP method (POST for RPC, GET for upgrade)
 *   - `pathname` — request URL pathname; the DO uses `/` exclusively
 *   - `ts` — unix milliseconds at sign time
 *   - `nonce` — 16-byte random hex; cheap replay disruption inside the
 *     60-second freshness window
 *   - `bodyHashHex` — SHA-256 hex digest of the raw request body bytes
 *     (`""` when there is no body)
 *   - `userId` — value of `X-Mymir-User-Id` when set (upgrade only),
 *     empty string otherwise; included so the user-id header cannot be
 *     swapped post-signing
 *
 * Header format: `X-Mymir-Broker-Sig: t=<ts>,n=<nonce>,v=<hex>`.
 *
 * Workers-only: this file is imported by `_broker.workers.ts` (adapter)
 * and `broker-do.ts` (DO). The self-host bundle ignores both, so this
 * module never reaches `_broker.node.ts`.
 */

/** Replay window for accepted timestamps. */
export const BROKER_SIG_MAX_SKEW_MS = 60_000;

/** Header name carrying the signed envelope. */
export const BROKER_SIG_HEADER = "X-Mymir-Broker-Sig";

/** Header name carrying the user id on the WS upgrade. */
export const BROKER_USER_ID_HEADER = "X-Mymir-User-Id";

/**
 * Parse a signed-envelope header into its three fields, or `null` when
 * the input is missing or malformed.
 *
 * @param header - Raw header value as received by the DO.
 * @returns `{ ts, nonce, signature }` or `null` if any field is absent or
 *   the timestamp does not parse to a finite number.
 */
export function parseSignatureHeader(
  header: string | null,
): { ts: number; nonce: string; signature: string } | null {
  if (!header) return null;
  const parts = header.split(",").map((part) => part.trim());
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const ts = Number.parseInt(fields.t ?? "", 10);
  const nonce = fields.n;
  const signature = fields.v;
  if (!Number.isFinite(ts) || !nonce || !signature) return null;
  return { ts, nonce, signature };
}

/**
 * Compute the hex SHA-256 digest of an ArrayBuffer or string. Used to
 * fold the request body into the signing input without sending the raw
 * bytes through the HMAC twice.
 *
 * @param input - Body to hash. Strings are UTF-8 encoded.
 * @returns Hex-encoded SHA-256 digest.
 */
export async function sha256Hex(
  input: ArrayBuffer | string,
): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(buf));
}

/**
 * Compute HMAC-SHA256 of {@link message} under {@link secret} and return
 * the hex-encoded MAC. Keys are imported per call; the DO and adapter
 * call this on every fetch which is acceptable at workerd's HMAC throughput.
 *
 * @param secret - Shared secret string (UTF-8 encoded for import).
 * @param message - Canonical signing string.
 * @returns Hex-encoded HMAC.
 */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return toHex(new Uint8Array(sig));
}

/**
 * Build the canonical signing string from request components. Both the
 * adapter and the DO must produce byte-identical output for the same
 * request, so this is the single shared definition.
 *
 * @param method - Uppercase HTTP method.
 * @param pathname - Request URL pathname.
 * @param ts - Unix milliseconds.
 * @param nonce - Random nonce hex.
 * @param bodyHashHex - SHA-256 hex of the body (or empty string).
 * @param userId - `X-Mymir-User-Id` header value, or empty string.
 * @returns Canonical signing string.
 */
export function buildSigningString(
  method: string,
  pathname: string,
  ts: number,
  nonce: string,
  bodyHashHex: string,
  userId: string,
): string {
  return `${method}.${pathname}.${ts}.${nonce}.${bodyHashHex}.${userId}`;
}

/**
 * Constant-time string comparison via byte-wise XOR-OR fold. Required to
 * keep signature comparison safe against timing oracles; never use plain
 * `===` on the hex MAC.
 *
 * @param a - First hex string.
 * @param b - Second hex string.
 * @returns `true` when both strings are the same length and content.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Build a random hex nonce for the envelope's `n` field. 16 bytes / 128
 * bits is ample for the 60-second replay window; collisions inside that
 * window are statistically impossible at any realistic Worker QPS.
 *
 * @returns 32-character hex string.
 */
export function buildNonceHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Hex-encode a byte array without padding or separators.
 *
 * @param bytes - Bytes to encode.
 * @returns Lowercase hex string.
 */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
