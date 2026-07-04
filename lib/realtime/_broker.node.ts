import "server-only";

/**
 * Resource-key shape carried in subscription maps.
 * - `project:<id>` — slim graph + chrome of a single project.
 * - `task:<id>` — full task body for a selected task.
 * - `note:<id>` — full note body for a selected note.
 * - `project-list:<userId>` — caller's home grid (project list).
 */
export type ResourceKey =
  | `project:${string}`
  | `task:${string}`
  | `note:${string}`
  | `project-list:${string}`;

/** SSE writer surface used by the broker — abstracted so tests can fake it. */
export interface Connection {
  /** Send a fully-formed SSE frame (caller is responsible for `data:` wrapping). */
  send(data: string): void;
  /** Close the underlying stream. */
  close(): void;
}

/**
 * Hard cap on concurrent SSE connections per authenticated user. Bounds the
 * DoS surface: without this, a single account could open unbounded
 * EventSource streams (each holding a heartbeat timer + ReadableStream
 * controller + sub map entry). Power multi-tab users typically hold 5-10
 * connections; 20 leaves headroom while still capping abuse.
 */
export const MAX_CONNECTIONS_PER_USER = 20;

/**
 * Per-user in-memory pub/sub for the realtime layer. Two maps — `subs` from
 * `userId → Map<resourceKey, expiresAt | null>` and `conns` from
 * `userId → Set<Connection>`. Resource subscription expiry is lazy-cleaned on
 * iteration so the broker holds no timers. Multi-tab cross-tab over-delivery
 * is accepted (Query no-ops invalidations on tabs lacking the key).
 */
class Broker {
  private subs = new Map<string, Map<ResourceKey, number | null>>();
  private conns = new Map<string, Set<Connection>>();

  /**
   * Register a subscription for the user. Pass `ttlMs` for time-bound
   * subscriptions (e.g. selected task body); omit for indefinite (e.g. user's
   * accessible project memberships, refreshed on SSE reconnect).
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   * @param ttlMs - Optional TTL in ms; omit for no expiry.
   */
  register(userId: string, key: ResourceKey, ttlMs?: number): void {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    let userMap = this.subs.get(userId);
    if (!userMap) {
      userMap = new Map();
      this.subs.set(userId, userMap);
    }
    userMap.set(key, expiresAt);
  }

  /**
   * Drop a single subscription early.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   */
  unregister(userId: string, key: ResourceKey): void {
    this.subs.get(userId)?.delete(key);
  }

  /**
   * Drop every `task:*` subscription for the user. Used by
   * {@link revokeOrgAccess} to ensure a member removed mid-session cannot
   * continue receiving task events for the revoked org's tasks until the
   * 10-minute TTL expires. Bulk drop (rather than a precise filter on the
   * revoked org's task ids) is correct because re-registering on the next
   * task fetch is free.
   *
   * Snapshots keys before mutation so deletions during iteration cannot
   * skip entries due to V8's implementation-defined behavior on
   * `Map#keys()` during `Map#delete()`.
   *
   * @param userId - Caller user id.
   */
  clearTaskSubs(userId: string): void {
    const userMap = this.subs.get(userId);
    if (!userMap) return;
    const taskKeys: ResourceKey[] = [];
    for (const key of userMap.keys()) {
      if (key.startsWith("task:")) taskKeys.push(key);
    }
    for (const key of taskKeys) userMap.delete(key);
  }

  /**
   * Attach a live SSE connection for the user.
   *
   * @param userId - Caller user id.
   * @param conn - SSE writer.
   */
  attach(userId: string, conn: Connection): void {
    let set = this.conns.get(userId);
    if (!set) {
      set = new Set();
      this.conns.set(userId, set);
    }
    set.add(conn);
  }

  /**
   * Atomically check the per-user connection cap and add {@link conn} when
   * room remains. Replaces the racy `isAtConnectionLimit` + `attach` pair as
   * the authoritative gate inside the SSE route's `start(controller)` —
   * concurrent `/api/events` requests cannot exceed the cap regardless of
   * how many pass an out-of-band `isAtConnectionLimit` check.
   *
   * @param userId - Caller user id.
   * @param conn - SSE writer.
   * @returns True when the connection was added; false when the user is at
   *   the cap and the connection was rejected.
   */
  tryAttach(userId: string, conn: Connection): boolean {
    let set = this.conns.get(userId);
    if (set && set.size >= MAX_CONNECTIONS_PER_USER) return false;
    if (!set) {
      set = new Set();
      this.conns.set(userId, set);
    }
    set.add(conn);
    return true;
  }

  /**
   * Whether the user already holds the maximum allowed concurrent
   * connections. Callers should reject new SSE streams with 429 when this
   * returns true so a single account can't exhaust process resources.
   *
   * @param userId - Caller user id.
   * @returns True when adding another connection would exceed the cap.
   */
  isAtConnectionLimit(userId: string): boolean {
    const current = this.conns.get(userId)?.size ?? 0;
    return current >= MAX_CONNECTIONS_PER_USER;
  }

  /**
   * Whether the user currently holds at least one SSE connection. Used by
   * realtime emit helpers to skip subscription bookkeeping for offline users
   * (the next SSE connect will hydrate the sub map from scratch anyway).
   *
   * @param userId - Caller user id.
   * @returns True when at least one connection is attached.
   */
  hasConnections(userId: string): boolean {
    return (this.conns.get(userId)?.size ?? 0) > 0;
  }

  /**
   * Detach a live SSE connection. When the user has zero remaining
   * connections, every subscription for the user is cleared too.
   *
   * @param userId - Caller user id.
   * @param conn - SSE writer to remove.
   */
  detach(userId: string, conn: Connection): void {
    const set = this.conns.get(userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.conns.delete(userId);
      this.subs.delete(userId);
    }
  }

  /**
   * Yield user ids currently subscribed to {@link key}. Lazy-cleans expired
   * subscriptions during iteration.
   *
   * @param key - Resource key to match.
   * @yields User ids with a live (non-expired) subscription on this key.
   */
  *subscribers(key: ResourceKey): Iterable<string> {
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
   * Walk the user's submap once and delete entries whose `expiresAt` is in
   * the past. Bounds the leak surface where TTL'd entries on
   * never-dispatched keys (opened-and-closed tasks) accumulate over a
   * long-lived SSE connection — the lazy GC in {@link subscribers} only
   * fires for the dispatched key, not for unrelated stale entries.
   *
   * Intended caller: the SSE heartbeat in `app/api/events/route.ts`.
   *
   * @param userId - Caller user id.
   */
  pruneExpired(userId: string): void {
    const userMap = this.subs.get(userId);
    if (!userMap) return;
    const now = Date.now();
    for (const [key, expiresAt] of userMap) {
      if (expiresAt !== null && expiresAt < now) userMap.delete(key);
    }
  }

  /**
   * Encode {@link payload} as an SSE `data:` frame and send to every
   * connection of every subscribed user. Errors raised by individual
   * connections are swallowed so one slow client cannot break delivery to the
   * others.
   *
   * @param key - Resource key.
   * @param payload - JSON-serializable event body.
   */
  dispatch(key: ResourceKey, payload: unknown): void {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const userId of this.subscribers(key)) {
      const set = this.conns.get(userId);
      if (!set) continue;
      for (const conn of set) {
        try {
          conn.send(frame);
        } catch {
          // Tolerate dead connections — `detach` is the cleanup path.
        }
      }
    }
  }

  /**
   * Dispatch multiple `{key, payload}` pairs in a single call. On self-host
   * this is purely a loop over `dispatch`; the Workers broker overrides it
   * to fold the items into a single DO sub-request so a wide fan-out (e.g.
   * `emitProjectListEvent` across M org members) does not pay M sub-request
   * round trips.
   *
   * @param items - Pairs to dispatch. Empty input is a no-op.
   */
  dispatchMany(items: Array<{ key: ResourceKey; payload: unknown }>): void {
    for (const { key, payload } of items) this.dispatch(key, payload);
  }

  /** Test-only — wipes every subscription and connection. */
  _resetForTests(): void {
    this.subs.clear();
    this.conns.clear();
  }
}

const g = globalThis as { __piyazBroker?: Broker };

/**
 * Process-wide broker singleton. Stored on `globalThis` so HMR + Next's
 * per-route module isolation share one instance.
 */
export const broker: Broker = (g.__piyazBroker ??= new Broker());

export type { Broker };
