import { DurableObject } from "cloudflare:workers";
import type { ResourceKey } from "./_broker.node";

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
  | { op: "dispatch"; key: ResourceKey; payload: unknown };

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
export class MymirBroker extends DurableObject<unknown> {
  private subs = new Map<string, Map<ResourceKey, number | null>>();

  /**
   * Handle a wire request from the Workers broker adapter. Routes WebSocket
   * upgrades to the hibernation accept path and JSON RPCs to the
   * subscription / dispatch handlers.
   *
   * @param request - Incoming fetch from the adapter or SSE handler.
   * @returns 101 on accepted upgrades, 204 on accepted RPCs, 4xx on bad
   *   input, 429 when a user is at the connection cap.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleUpgrade(request);
    }
    return this.handleRpc(request);
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
    const userId = request.headers.get("X-Mymir-User-Id");
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
   * `dispatch`, fan the payload out to every matching user's WebSockets.
   *
   * @param request - JSON-body fetch from the adapter.
   * @returns 204 on success, 400 on malformed body or unknown op.
   */
  private async handleRpc(request: Request): Promise<Response> {
    const msg = (await request
      .json()
      .catch(() => null)) as BrokerMessage | null;
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
   * @param userId - Caller user id.
   */
  private clearTaskSubs(userId: string): void {
    const userMap = this.subs.get(userId);
    if (!userMap) return;
    for (const key of userMap.keys()) {
      if (key.startsWith("task:")) userMap.delete(key);
    }
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
    const remaining = this.ctx
      .getWebSockets(userId)
      .filter((s) => s !== ws).length;
    if (remaining === 0) {
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
