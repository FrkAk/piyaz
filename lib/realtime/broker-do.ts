import { DurableObject } from "cloudflare:workers";
import type { ResourceKey } from "./_broker.node";
import {
  BROKER_SIG_HEADER,
  BROKER_SIG_MAX_SKEW_MS,
  BROKER_USER_ID_HEADER,
  buildSigningString,
  constantTimeEqual,
  hmacSha256Hex,
  parseSignatureHeader,
  sha256Hex,
} from "./broker-auth";

/**
 * Wire message sent to the `MymirBroker` Durable Object over the
 * `fetch(request)` boundary. The DO holds the single broker-global view of
 * every user's subscriptions and connected WebSockets.
 */
export type BrokerMessage =
  | { op: "register"; userId: string; key: ResourceKey; ttlMs?: number }
  | { op: "unregister"; userId: string; key: ResourceKey }
  | { op: "clear-task-subs"; userId: string }
  | { op: "detach"; userId: string }
  | { op: "dispatch"; key: ResourceKey; payload: unknown }
  | {
      op: "dispatch-many";
      items: Array<{ key: ResourceKey; payload: unknown }>;
    };

/**
 * Env-shape the DO reads. Only the HMAC secret is relevant today; declared
 * structurally so we don't pull in `@cloudflare/workers-types` (which would
 * clobber DOM `Request` / `Response` globally and break unrelated tests).
 */
interface BrokerEnv {
  BROKER_DO_SECRET?: string;
}

/**
 * Hard cap on concurrent WebSocket connections per authenticated user.
 * Mirrors `MAX_CONNECTIONS_PER_USER` in `_broker.node.ts` so the two backends
 * enforce identical limits.
 */
const MAX_CONNECTIONS_PER_USER = 20;

/**
 * Cloudflare Durable Object that replaces the self-host in-memory broker for
 * the Workers deploy target. A single global instance (id derived from a
 * stable name) multiplexes every user's subscription state and WebSocket
 * connections, matching the self-host single-process broker semantics.
 *
 * Subscription state lives in memory and is not persisted: the model is that
 * clients re-register their `project:*` / `task:*` / `project-list:*`
 * subscriptions on each SSE reconnect, identical to the self-host broker
 * losing state on process restart. WebSocket connections survive hibernation
 * via Cloudflare's WebSocket Hibernation API and are restored when the DO
 * rehydrates.
 */
export class MymirBroker extends DurableObject<BrokerEnv> {
  private subs = new Map<string, Map<ResourceKey, number | null>>();

  /**
   * Handle a wire request from the Workers broker adapter. Verifies the
   * HMAC envelope, then routes WebSocket upgrades to the hibernation
   * accept path and JSON RPCs to the subscription / dispatch handlers.
   *
   * The DO is only reachable to Workers that hold the `MYMIR_BROKER`
   * binding, but the binding alone is not authentication: any caller
   * with the binding could spoof `userId` or fabricate dispatches if the
   * envelope check were skipped. The check rejects every unsigned or
   * mis-signed request with 401 so the DO becomes a closed system that
   * trusts only the in-process adapter (which signs with the shared
   * `BROKER_DO_SECRET`).
   *
   * @param request - Incoming fetch from the adapter or SSE handler.
   * @returns 101 on accepted upgrades, 204 on accepted RPCs, 4xx on bad
   *   input, 401 when the envelope is missing or invalid, 429 when a
   *   user is at the connection cap, 503 when the DO has no secret bound.
   */
  async fetch(request: Request): Promise<Response> {
    const authResult = await this.verifyEnvelope(request);
    if (!authResult.ok) {
      return new Response(authResult.error, { status: authResult.status });
    }
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleUpgrade(request);
    }
    return this.handleRpc(authResult.body);
  }

  /**
   * Verify the HMAC envelope on the request. Returns the request body as
   * a string (or `""` for upgrades) so the caller does not need to
   * re-read it for parsing. Constant-time signature comparison and a
   * 60-second freshness window are enforced; the userId header (set on
   * upgrades) is folded into the signing input so it cannot be swapped
   * after signing.
   *
   * @param request - Incoming fetch.
   * @returns `{ ok: true, body }` on success; `{ ok: false, status, error }`
   *   otherwise.
   */
  private async verifyEnvelope(
    request: Request,
  ): Promise<
    | { ok: true; body: string }
    | { ok: false; status: number; error: string }
  > {
    const secret = this.env.BROKER_DO_SECRET;
    if (!secret) {
      return {
        ok: false,
        status: 503,
        error: "BROKER_DO_SECRET unset",
      };
    }
    const header = parseSignatureHeader(request.headers.get(BROKER_SIG_HEADER));
    if (!header) {
      return { ok: false, status: 401, error: "Missing or malformed signature" };
    }
    const now = Date.now();
    if (Math.abs(now - header.ts) > BROKER_SIG_MAX_SKEW_MS) {
      return { ok: false, status: 401, error: "Signature stale" };
    }
    const url = new URL(request.url);
    const body = await request.text();
    const bodyHashHex = await sha256Hex(body);
    const userId = request.headers.get(BROKER_USER_ID_HEADER) ?? "";
    const signingString = buildSigningString(
      request.method,
      url.pathname,
      header.ts,
      header.nonce,
      bodyHashHex,
      userId,
    );
    const expected = await hmacSha256Hex(secret, signingString);
    if (!constantTimeEqual(expected, header.signature)) {
      return { ok: false, status: 401, error: "Signature mismatch" };
    }
    return { ok: true, body };
  }

  /**
   * Accept a new WebSocket on behalf of the user named in
   * `X-Mymir-User-Id`. Enforces the per-user cap before allocating the
   * socket pair so a saturated user is rejected without consuming resources.
   *
   * @param request - Upgrade request carrying the user id header.
   * @returns 101 with the client socket on success, 400 when the header is
   *   missing, 429 when the user is already at the cap.
   */
  private handleUpgrade(request: Request): Response {
    const userId = request.headers.get(BROKER_USER_ID_HEADER);
    if (!userId) {
      return new Response("Missing X-Mymir-User-Id", { status: 400 });
    }
    if (this.ctx.getWebSockets(userId).length >= MAX_CONNECTIONS_PER_USER) {
      return new Response("Connection limit reached", { status: 429 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [userId]);
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocketLike });
  }

  /**
   * Apply a {@link BrokerMessage} to the in-memory subscription map and, for
   * `dispatch` / `dispatch-many`, fan the payload out to every matching
   * user's WebSockets.
   *
   * @param body - JSON-encoded message body (pre-read by `verifyEnvelope`).
   * @returns 204 on success, 400 on malformed body or unknown op.
   */
  private async handleRpc(body: string): Promise<Response> {
    let msg: BrokerMessage | null;
    try {
      msg = JSON.parse(body) as BrokerMessage;
    } catch {
      msg = null;
    }
    if (!msg || typeof msg !== "object" || typeof msg.op !== "string") {
      return new Response("Bad request", { status: 400 });
    }
    switch (msg.op) {
      case "register":
        this.register(msg.userId, msg.key, msg.ttlMs);
        return new Response(null, { status: 204 });
      case "unregister":
        this.unregister(msg.userId, msg.key);
        return new Response(null, { status: 204 });
      case "clear-task-subs":
        this.clearTaskSubs(msg.userId);
        return new Response(null, { status: 204 });
      case "detach":
        return new Response(null, { status: 204 });
      case "dispatch":
        this.dispatch(msg.key, msg.payload);
        return new Response(null, { status: 204 });
      case "dispatch-many":
        if (!Array.isArray(msg.items)) {
          return new Response("dispatch-many: items must be an array", {
            status: 400,
          });
        }
        for (const item of msg.items) this.dispatch(item.key, item.payload);
        return new Response(null, { status: 204 });
      default:
        return new Response("Unknown op", { status: 400 });
    }
  }

  /**
   * Record a subscription for the user. `ttlMs` produces a lazy-expiring
   * entry (cleaned on next `subscribers` iteration); omit for indefinite.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   * @param ttlMs - Optional TTL in ms.
   */
  private register(userId: string, key: ResourceKey, ttlMs?: number): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    let userMap = this.subs.get(userId);
    if (!userMap) {
      userMap = new Map();
      this.subs.set(userId, userMap);
    }
    userMap.set(key, expiresAt);
  }

  /**
   * Drop a single subscription for the user.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   */
  private unregister(userId: string, key: ResourceKey): void {
    this.subs.get(userId)?.delete(key);
  }

  /**
   * Drop every `task:*` subscription for the user. Mirrors the self-host
   * `clearTaskSubs` used by `revokeOrgAccess` to ensure a removed member
   * stops receiving task events for their former org's tasks immediately.
   *
   * Snapshots keys before mutation so deletions during iteration cannot
   * skip entries due to V8/workerd's implementation-defined behavior on
   * `Map#keys()` during `Map#delete()`.
   *
   * @param userId - Caller user id.
   */
  private clearTaskSubs(userId: string): void {
    const userMap = this.subs.get(userId);
    if (!userMap) return;
    const taskKeys: ResourceKey[] = [];
    for (const key of userMap.keys()) {
      if (key.startsWith("task:")) taskKeys.push(key);
    }
    for (const key of taskKeys) userMap.delete(key);
  }

  /**
   * Encode {@link payload} as an SSE `data:` frame and send to every
   * WebSocket of every user with a live (non-expired) subscription on
   * {@link key}. Per-socket send errors are swallowed so one dead pipe
   * cannot break delivery to siblings.
   *
   * @param key - Resource key.
   * @param payload - JSON-serializable event body.
   */
  private dispatch(key: ResourceKey, payload: unknown): void {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const userId of this.subscribers(key)) {
      const sockets = this.ctx.getWebSockets(userId);
      for (const ws of sockets) {
        try {
          ws.send(frame);
        } catch {}
      }
    }
  }

  /**
   * Yield user ids currently subscribed to {@link key}. Lazy-cleans expired
   * entries during iteration so the DO holds no expiry timers.
   *
   * @param key - Resource key to match.
   * @yields User ids with a live subscription on {@link key}.
   */
  private *subscribers(key: ResourceKey): Iterable<string> {
    const now = Date.now();
    for (const [userId, userMap] of this.subs) {
      const expiresAt = userMap.get(key);
      if (expiresAt === undefined) continue;
      if (expiresAt !== null && expiresAt < now) {
        userMap.delete(key);
        continue;
      }
      yield userId;
    }
  }

  /**
   * Hibernation-API callback fired when a WebSocket closes. Reads the user
   * id from the tags attached at `acceptWebSocket` time and, when no
   * sockets remain for that user, clears their subscription map — matching
   * the self-host broker's "drop subs on last detach" semantics.
   *
   * Lean on the workerd hibernation contract that the closing socket is
   * already absent from `getWebSockets(userId)` by the time the callback
   * runs — comparing identities directly is unreliable after rehydration
   * because the deserialized `ws` handle may not be referentially equal to
   * the entry that remains in the tag list. The trade-off: if a future
   * runtime regression keeps the closing socket in the set, we skip the
   * delete (subs persist until the next close for the same user) rather
   * than wipe a user whose other connections are still live.
   *
   * @param ws - The closing WebSocket.
   * @param _code - Close code (unused).
   * @param _reason - Close reason (unused).
   * @param _wasClean - Whether the close was clean (unused).
   */
  webSocketClose(
    ws: WebSocketLike,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    const tags = this.ctx.getTags(ws);
    const userId = tags[0];
    if (!userId) return;
    if (this.ctx.getWebSockets(userId).length === 0) {
      this.subs.delete(userId);
    }
  }

  /**
   * Hibernation-API callback fired on WebSocket errors. Logged for
   * observability; workerd auto-closes the socket so no further action is
   * needed (the close handler will clean subs).
   *
   * @param _ws - The errored WebSocket.
   * @param error - The error raised by workerd.
   */
  webSocketError(_ws: WebSocketLike, error: unknown): void {
    console.error("[realtime] websocket error:", error);
  }
}
