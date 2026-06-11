/**
 * Structured replacement for Better Auth's default router error logging.
 *
 * Wired as `onAPIError.onError` in `lib/auth.ts`. Better Auth's default
 * `onError` (`better-auth/dist/api/index.mjs`) logs caught errors
 * message-only, so production 500s on `/api/auth/*` routes surface
 * without a stack and cannot be traced to a throw site. This hook logs
 * every stack the error object carries: better-call's `APIError` hides
 * its construction frames behind the `errorStack` getter (`stack` is
 * emptied via `Error.stackTraceLimit = 0`), and the originating error
 * usually rides the `cause` chain.
 */

/** One entry of a serialized `cause` chain. */
interface SerializedCause {
  /** Error class name, when the cause is an `Error`. */
  name?: string;
  /** Cause message, or its string form for non-`Error` values. */
  message: string;
  /** Cause stack, when available. */
  stack?: string;
}

/** Maximum `cause` chain depth serialized into one log entry. */
const MAX_CAUSE_DEPTH = 5;

/** Length cap for logged messages. */
const MAX_MESSAGE_LENGTH = 500;

/** Length cap for logged stacks. */
const MAX_STACK_LENGTH = 4_000;

/** Email addresses — the realistic PII vector in auth error text. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Postgres constraint details of the form `(column)=(value)` — error
 * messages like `Key (email)=(x) already exists` embed row values.
 */
const KEY_DETAIL_RE = /(\([^)=]*\))=\([^)]*\)/g;

/**
 * Redact user data from error text and cap its length. Stacks repeat
 * the error message on their first line, so both fields are scrubbed.
 *
 * @param text - Message or stack text destined for the log.
 * @param maxLength - Cap applied after redaction.
 * @returns Scrubbed text, or `undefined` when the input was absent.
 */
function scrub(
  text: string | undefined,
  maxLength: number,
): string | undefined {
  if (text === undefined) return undefined;
  const redacted = text
    .replace(KEY_DETAIL_RE, "$1=([redacted])")
    .replace(EMAIL_RE, "[email]");
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}

/**
 * Walk an error's `cause` chain (including better-call's `body.cause`
 * carrier) into a JSON-safe array.
 *
 * @param error - The logged error whose causes are collected.
 * @returns Serialized causes, outermost first; empty when none exist.
 */
function serializeCauseChain(error: unknown): SerializedCause[] {
  const shaped = error as {
    cause?: unknown;
    body?: { cause?: unknown };
  } | null;
  const causes: SerializedCause[] = [];
  const seen = new Set<unknown>();
  let current = shaped?.cause ?? shaped?.body?.cause;
  while (
    current != null &&
    causes.length < MAX_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    if (current instanceof Error) {
      causes.push({
        name: current.name,
        message: scrub(current.message, MAX_MESSAGE_LENGTH) ?? "",
        stack: scrub(current.stack, MAX_STACK_LENGTH),
      });
      current = current.cause;
    } else {
      causes.push({
        message: scrub(String(current), MAX_MESSAGE_LENGTH) ?? "",
      });
      break;
    }
  }
  return causes;
}

/**
 * Log a Better Auth API error as structured JSON with full stack data.
 *
 * Emits only for 5xx-class errors (or errors with no numeric
 * `statusCode`, which are unexpected throws): 4xx APIErrors are routine
 * auth outcomes Better Auth's default logger also keeps quiet about.
 * Every text field is passed through {@link scrub} so database error
 * details cannot leak user data into logs. Never throws — the hook runs
 * inside better-call's router catch, where a logging failure would
 * replace the original error.
 *
 * @param error - The raw error better-call's router caught.
 */
export function logAuthApiError(error: unknown): void {
  const shaped = error as {
    name?: string;
    message?: string;
    status?: unknown;
    statusCode?: unknown;
    stack?: string;
    errorStack?: string;
  } | null;
  const statusCode =
    typeof shaped?.statusCode === "number" ? shaped.statusCode : undefined;
  if (statusCode !== undefined && statusCode < 500) return;
  console.error(
    JSON.stringify({
      event: "better_auth_api_error",
      name: shaped?.name,
      status: typeof shaped?.status === "string" ? shaped.status : undefined,
      statusCode,
      message: scrub(
        typeof shaped?.message === "string" ? shaped.message : String(error),
        MAX_MESSAGE_LENGTH,
      ),
      stack: scrub(shaped?.errorStack ?? shaped?.stack, MAX_STACK_LENGTH),
      causes: serializeCauseChain(error),
    }),
  );
}
