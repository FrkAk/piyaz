import "server-only";

/**
 * Resource-key shape carried in subscription maps.
 * - `project:<id>` — slim graph + chrome of a single project.
 * - `task:<id>` — full task body for a selected task.
 * - `project-list:<userId>` — caller's home grid (project list).
 */
export type ResourceKey =
  | `project:${string}`
  | `task:${string}`
  | `project-list:${string}`;

/** SSE writer surface used by the broker — abstracted so tests can fake it. */
export interface Connection {
  /** Send a fully-formed SSE frame (caller is responsible for `data:` wrapping). */
  send(data: string): void;
  /** Close the underlying stream. */
  close(): void;
}

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

  /** Test-only — wipes every subscription and connection. */
  _resetForTests(): void {
    this.subs.clear();
    this.conns.clear();
  }
}

const g = globalThis as { __mymirBroker?: Broker };

/**
 * Process-wide broker singleton. Stored on `globalThis` so HMR + Next's
 * per-route module isolation share one instance.
 */
export const broker: Broker = (g.__mymirBroker ??= new Broker());

export type { Broker };
