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
export interface DurableObjectNamespace {
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
const BROKER_DO_NAME = "piyaz-broker-global";

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
 * @param userId - `X-Piyaz-User-Id` value or empty string.
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
   * Resolve the stub for the broker-global DO. Uses {@link namespace} when
   * the caller passes the binding explicitly (the raw worker entry runs
   * outside OpenNext's request-context ALS, where `getCloudflareContext`
   * throws). Otherwise reads the binding from the Cloudflare request
   * context rather than `globalThis`: modules-format Workers never expose
   * bindings on the global object, so the old read silently no-oped every
   * dispatch. Logs once per isolate when the binding is missing or the
   * context is unavailable so misconfigured deploys are diagnosable
   * without spamming.
   *
   * @param namespace - Explicit `PIYAZ_BROKER` binding from the worker
   *   entry's `env`; omit inside route handlers.
   * @returns The DO stub, or `null` when `PIYAZ_BROKER` is not bound.
   */
  private stub(namespace?: DurableObjectNamespace): DurableObjectStub | null {
    let resolved = namespace;
    if (!resolved) {
      try {
        resolved = (
          getCloudflareContext({ async: false }).env as {
            PIYAZ_BROKER?: DurableObjectNamespace;
          }
        ).PIYAZ_BROKER;
      } catch {
        resolved = undefined;
      }
    }
    if (!resolved) {
      if (!warnedMissingBinding) {
        console.error(
          "[realtime] PIYAZ_BROKER binding missing — realtime fanout will silently no-op",
        );
        warnedMissingBinding = true;
      }
      return null;
    }
    const id = resolved.idFromName(BROKER_DO_NAME);
    return resolved.get(id);
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
   * Register many subscriptions for the user in a single awaited DO RPC.
   * Used by the worker entry to complete every registration before the 101
   * returns, so the socket is never connected-but-deaf. Unlike
   * {@link register}, this is not fire-and-forget: the caller awaits the
   * DO acknowledgment and handles failures itself.
   *
   * @param userId - Caller user id.
   * @param keys - Resource keys to register (no TTL).
   * @param namespace - Explicit `PIYAZ_BROKER` binding from the worker
   *   entry's `env`; omit inside route handlers.
   * @throws When the binding or signing secret is missing, or the DO
   *   fetch rejects.
   */
  async registerMany(
    userId: string,
    keys: ResourceKey[],
    namespace?: DurableObjectNamespace,
  ): Promise<void> {
    const stub = this.stub(namespace);
    if (!stub) {
      throw new Error(
        "PiyazBroker binding missing — cannot register subscriptions",
      );
    }
    const msg: BrokerMessage = {
      op: "register-many",
      userId,
      items: keys.map((key) => ({ key })),
    };
    const body = JSON.stringify(msg);
    const { init, secretPresent } = await signedRequestInit("POST", body, "");
    if (!secretPresent) {
      throw new Error(
        "BROKER_DO_SECRET unset — refusing to send an unsigned " +
          "register-many to the broker DO",
      );
    }
    await stub.fetch(BROKER_URL, init);
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
   * Drop every `task:*` and `note:*` subscription for the user.
   *
   * @param userId - Caller user id.
   */
  clearTaskSubs(userId: string): void {
    this.fireAndForget({ op: "clear-task-subs", userId });
  }

  /**
   * Drop every user's subscription on {@link key} except
   * {@link keepUserId}'s. Fire-and-forget: on Workers the purge and any
   * just-dispatched event race as separate DO sub-requests, so delivery
   * of a final event to purged users is best-effort.
   *
   * @param key - Resource key to purge.
   * @param keepUserId - User whose subscription survives; omit to purge all.
   */
  purgeKeySubs(key: ResourceKey, keepUserId?: string): void {
    this.fireAndForget({ op: "purge-key-subs", key, keepUserId });
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
   * @param namespace - Explicit `PIYAZ_BROKER` binding from the worker
   *   entry's `env`; omit inside route handlers.
   * @returns The client end of the WebSocket pair.
   * @throws When the binding is missing, the secret is missing, or the DO
   *   rejects the upgrade.
   */
  async connect(
    userId: string,
    namespace?: DurableObjectNamespace,
  ): Promise<WebSocket> {
    const stub = this.stub(namespace);
    if (!stub) {
      throw new Error(
        "PiyazBroker binding missing — cannot open WebSocket to DO",
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
      throw new Error(`PiyazBroker upgrade failed: status ${resp.status}`);
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
      "PiyazBroker WorkersBroker: attach is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
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
      "PiyazBroker WorkersBroker: tryAttach is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
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
      "PiyazBroker WorkersBroker: isAtConnectionLimit is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }

  /**
   * Whether the user may hold a live connection. The DO owns the WebSocket
   * set, so the entry/route cannot synchronously know liveness; assume
   * possibly-connected so the caller's lazy `task:` / `project:`
   * registration proceeds. Registering a sub for a user with no live
   * socket is harmless: the DO only delivers to real sockets, and `task:`
   * subs carry a TTL.
   *
   * @param _userId - Caller user id (unused).
   * @returns Always true.
   */
  hasConnections(_userId: string): boolean {
    return true;
  }

  /**
   * Subscriber enumeration — not callable on Workers. The DO performs
   * fanout internally inside `dispatch`.
   *
   * @throws Always.
   */
  *subscribers(_key: ResourceKey): Iterable<string> {
    throw new Error(
      "PiyazBroker WorkersBroker: subscribers is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
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
      "PiyazBroker WorkersBroker: pruneExpired is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
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
      "PiyazBroker WorkersBroker: _resetForTests is not callable from Workers; use connect(userId) to obtain a WebSocket from the DO",
    );
  }
}

export type Broker = WorkersBroker;

/** Workers broker singleton — instance is cheap; the DO holds the state. */
export const broker: WorkersBroker = new WorkersBroker();
