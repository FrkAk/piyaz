import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { BrokerMessage } from "./broker-do";
import type { Connection, ResourceKey } from "./_broker.node";
import {
  BROKER_SIG_HEADER,
  BROKER_USER_ID_HEADER,
  buildNonceHex,
  buildSigningString,
  hmacSha256Hex,
  sha256Hex,
} from "./broker-auth";

/**
 * Minimal structural shape of the Durable Object binding we depend on.
 * Avoids pulling `@cloudflare/workers-types` into global scope (which would
 * override DOM `Response` / `Request` types across the codebase and break
 * unrelated tests). The ESLint config bans that import; the local stubs
 * below cover every method this adapter calls.
 */
interface DurableObjectStub {
  fetch(url: string, init?: RequestInit): Promise<DurableObjectResponse>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
interface DurableObjectResponse {
  readonly status: number;
  readonly webSocket: WebSocket | null;
}

export {
  MAX_CONNECTIONS_PER_USER,
  type Connection,
  type ResourceKey,
} from "./_broker.node";

/** Stable name for the single broker DO that owns every user's subs. */
const BROKER_DO_NAME = "mymir-broker-global";

/** Canonical request URL the adapter targets — fixed so signatures match. */
const BROKER_URL = "https://broker/";

/** Module-scoped flag so the missing-binding warning fires once per isolate. */
let warnedMissingBinding = false;

/** Module-scoped flag so the missing-secret warning fires once per isolate. */
let warnedMissingSecret = false;

/**
 * Resolve the HMAC secret used to sign broker envelopes. Reads
 * `BROKER_DO_SECRET` from `process.env` so the same value flows in via
 * `wrangler secret put` on production and `.dev.vars` on local preview.
 *
 * @returns The shared secret, or `null` when unset. The adapter refuses
 *   to send unsigned messages when the secret is missing rather than
 *   silently downgrading authentication.
 */
function resolveBrokerSecret(): string | null {
  const secret = process.env.BROKER_DO_SECRET;
  if (!secret) {
    if (!warnedMissingSecret) {
      console.error(
        "[realtime] BROKER_DO_SECRET unset — broker dispatches will be dropped. " +
          "Set via 'wrangler secret put BROKER_DO_SECRET'.",
      );
      warnedMissingSecret = true;
    }
    return null;
  }
  return secret;
}

/**
 * Build a signed `RequestInit` for a fetch to the broker DO. Computes the
 * SHA-256 of the body and the HMAC of the canonical signing string, then
 * returns headers plus the body ready to ship.
 *
 * @param method - HTTP method (POST or GET).
 * @param body - Body bytes or `null` for upgrade.
 * @param userId - `X-Mymir-User-Id` value or empty string.
 * @returns `RequestInit` with method, headers, and body populated.
 */
async function signedRequestInit(
  method: "POST" | "GET",
  body: string | null,
  userId: string,
): Promise<{ init: RequestInit; secretPresent: boolean }> {
  const secret = resolveBrokerSecret();
  if (!secret) return { init: { method }, secretPresent: false };

  const ts = Date.now();
  const nonce = buildNonceHex();
  const bodyHashHex = await sha256Hex(body ?? "");
  const signingString = buildSigningString(
    method,
    "/",
    ts,
    nonce,
    bodyHashHex,
    userId,
  );
  const signature = await hmacSha256Hex(secret, signingString);

  const headers: Record<string, string> = {
    [BROKER_SIG_HEADER]: `t=${ts},n=${nonce},v=${signature}`,
  };
  if (method === "POST") headers["content-type"] = "application/json";
  if (userId) headers[BROKER_USER_ID_HEADER] = userId;
  if (method === "GET") headers.Upgrade = "websocket";

  return {
    init: { method, headers, body: body ?? undefined },
    secretPresent: true,
  };
}

/**
 * Best-effort enrollment of a fire-and-forget broker send into the
 * current Workers request's `ctx.waitUntil`. Workers terminate pending
 * I/O at Response return, so without `waitUntil` the DO sub-request can
 * be cut off and the event lost.
 *
 * Silently degrades when there is no active Cloudflare context (rare:
 * tests, scheduled handlers) — the caller's `.catch` keeps the promise
 * from raising unhandled rejections regardless.
 *
 * @param promise - The send promise to enroll.
 */
function enrollInWaitUntil(promise: Promise<unknown>): void {
  try {
    const { ctx } = getCloudflareContext({ async: false });
    ctx.waitUntil(promise);
  } catch {
    /* no active CF context; the promise still resolves naturally */
  }
}

/**
 * Cloudflare Workers Durable Object adapter for the realtime broker. Routes
 * every subscription mutation and dispatch to a single global DO instance
 * via fetch RPC; provides {@link WorkersBroker.connect} for SSE handlers to
 * obtain a WebSocket end of the DO connection. Per-isolate stateless —
 * authoritative state lives in the DO.
 */
class WorkersBroker {
  /**
   * Resolve the stub for the broker-global DO. Reads the binding from the
   * Cloudflare request context rather than `globalThis`: modules-format
   * Workers never expose bindings on the global object, so the old read
   * silently no-oped every dispatch. Logs once per isolate when the binding
   * is missing or the context is unavailable so misconfigured deploys are
   * diagnosable without spamming.
   *
   * @returns The DO stub, or `null` when `MYMIR_BROKER` is not bound.
   */
  private stub(): DurableObjectStub | null {
    let namespace: DurableObjectNamespace | undefined;
    try {
      namespace = (
        getCloudflareContext({ async: false }).env as {
          MYMIR_BROKER?: DurableObjectNamespace;
        }
      ).MYMIR_BROKER;
    } catch {
      namespace = undefined;
    }
    if (!namespace) {
      if (!warnedMissingBinding) {
        console.error(
          "[realtime] MYMIR_BROKER binding missing — realtime fanout will silently no-op",
        );
        warnedMissingBinding = true;
      }
      return null;
    }
    const id = namespace.idFromName(BROKER_DO_NAME);
    return namespace.get(id);
  }

  /**
   * Send a wire message to the broker DO with HMAC signing and
   * `ctx.waitUntil` enrollment. Errors are swallowed so a transient DO
   * failure does not break the caller's mutation that already committed;
   * the failing op is included in the log for diagnosis.
   *
   * @param msg - Wire payload.
   * @returns Promise resolving when the DO acknowledges, or after error
   *   logging. Always resolves; never rejects.
   */
  private async send(msg: BrokerMessage): Promise<void> {
    const stub = this.stub();
    if (!stub) return;
    const body = JSON.stringify(msg);
    const { init, secretPresent } = await signedRequestInit("POST", body, "");
    if (!secretPresent) return;
    try {
      await stub.fetch(BROKER_URL, init);
    } catch (err) {
      console.error("[realtime] broker send failed:", err, { op: msg.op });
    }
  }

  /**
   * Schedule {@link send} on the next microtask and enroll the result in
   * `ctx.waitUntil` so the response can return without losing the
   * DO sub-request. Centralizes the fire-and-forget pattern used by every
   * non-await mutation in this adapter.
   *
   * @param msg - Wire payload.
   */
  private fireAndForget(msg: BrokerMessage): void {
    const promise = this.send(msg).catch((err) => {
      console.error("[realtime] broker send rejected:", err, { op: msg.op });
    });
    enrollInWaitUntil(promise);
  }

  /**
   * Register a subscription for the user.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   * @param ttlMs - Optional TTL in ms; omit for no expiry.
   */
  register(userId: string, key: ResourceKey, ttlMs?: number): void {
    this.fireAndForget({ op: "register", userId, key, ttlMs });
  }

  /**
   * Drop a single subscription early.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   */
  unregister(userId: string, key: ResourceKey): void {
    this.fireAndForget({ op: "unregister", userId, key });
  }

  /**
   * Drop every `task:*` subscription for the user.
   *
   * @param userId - Caller user id.
   */
  clearTaskSubs(userId: string): void {
    this.fireAndForget({ op: "clear-task-subs", userId });
  }

  /**
   * Notify the DO that an SSE handler is detaching a connection.
   * Informational only — the DO discovers the real detach via
   * `webSocketClose`. Forwarded so future diagnostic ops can hook in
   * without changing the adapter API.
   *
   * @param userId - Caller user id.
   * @param _conn - SSE writer to remove (unused; identified DO-side).
   */
  detach(userId: string, _conn: Connection): void {
    this.fireAndForget({ op: "detach", userId });
  }

  /**
   * Dispatch a payload to every connection of every subscribed user. The DO
   * owns both the subscription map and the connected WebSockets, so the
   * adapter forwards the intent without naming any recipient.
   *
   * @param key - Resource key.
   * @param payload - JSON-serializable event body.
   */
  dispatch(key: ResourceKey, payload: unknown): void {
    this.fireAndForget({ op: "dispatch", key, payload });
  }

  /**
   * Dispatch many `{key, payload}` pairs in a single DO sub-request. Used
   * by `emitProjectListEvent` to fan out to every org member without
   * paying N sub-requests against the Workers ceiling.
   *
   * @param items - Pairs to dispatch. No-ops on empty input.
   */
  dispatchMany(items: Array<{ key: ResourceKey; payload: unknown }>): void {
    if (items.length === 0) return;
    this.fireAndForget({ op: "dispatch-many", items });
  }

  /**
   * Open a WebSocket end of the broker DO for the given user. The caller
   * (SSE route, deferred to MYMR-167) is expected to pipe the WebSocket's
   * incoming frames into the SSE response stream.
   *
   * @param userId - Caller user id; attached as the DO-side tag.
   * @returns The client end of the WebSocket pair.
   * @throws When the binding is missing, the secret is missing, or the DO
   *   rejects the upgrade.
   */
  async connect(userId: string): Promise<WebSocket> {
    const stub = this.stub();
    if (!stub) {
      throw new Error(
        "MymirBroker binding missing — cannot open WebSocket to DO",
      );
    }
    const { init, secretPresent } = await signedRequestInit(
      "GET",
      null,
      userId,
    );
    if (!secretPresent) {
      throw new Error(
        "BROKER_DO_SECRET unset — refusing to open an unauthenticated " +
          "WebSocket to the broker DO",
      );
    }
    const resp = await stub.fetch(BROKER_URL, init);
    if (resp.status !== 101 || !resp.webSocket) {
      throw new Error(`MymirBroker upgrade failed: status ${resp.status}`);
    }
    return resp.webSocket;
  }

  /**
   * SSE-route attach surface — not callable on Workers. SSE handlers must
   * obtain a DO-backed WebSocket via {@link connect} instead.
   *
   * @throws Always.
   */
  attach(_userId: string, _conn: Connection): void {
    throw new Error(
      "MymirBroker WorkersBroker: attach is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }

  /**
   * SSE-route attach surface — not callable on Workers. The DO enforces the
   * per-user cap inside the upgrade handler.
   *
   * @throws Always.
   */
  tryAttach(_userId: string, _conn: Connection): boolean {
    throw new Error(
      "MymirBroker WorkersBroker: tryAttach is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }

  /**
   * SSE-route attach surface — not callable on Workers. The DO enforces the
   * per-user cap inside the upgrade handler.
   *
   * @throws Always.
   */
  isAtConnectionLimit(_userId: string): boolean {
    throw new Error(
      "MymirBroker WorkersBroker: isAtConnectionLimit is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }

  /**
   * Connection-tracking surface — not callable on Workers. The DO owns the
   * WebSocket set and would require an extra round-trip per call.
   *
   * @throws Always.
   */
  hasConnections(_userId: string): boolean {
    throw new Error(
      "MymirBroker WorkersBroker: hasConnections is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }

  /**
   * Subscriber enumeration — not callable on Workers. The DO performs
   * fanout internally inside `dispatch`.
   *
   * @throws Always.
   */
  *subscribers(_key: ResourceKey): Iterable<string> {
    throw new Error(
      "MymirBroker WorkersBroker: subscribers is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }

  /**
   * SSE-heartbeat prune surface — not callable on Workers. The DO
   * lazy-cleans expired entries during dispatch iteration.
   *
   * @throws Always.
   */
  pruneExpired(_userId: string): void {
    throw new Error(
      "MymirBroker WorkersBroker: pruneExpired is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }

  /**
   * Test-only reset — not callable on Workers. DO-side state is reset by
   * the test harness fake; production code should never call this.
   *
   * @throws Always.
   */
  _resetForTests(): void {
    throw new Error(
      "MymirBroker WorkersBroker: _resetForTests is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }
}

export type Broker = WorkersBroker;

/** Workers broker singleton — instance is cheap; the DO holds the state. */
export const broker: WorkersBroker = new WorkersBroker();
