import "server-only";

import type { BrokerMessage } from "./broker-do";

/**
 * Minimal structural shape of the Durable Object binding we depend on.
 * Avoids pulling `@cloudflare/workers-types` into global scope (which
 * would override DOM `Response` / `Request` types across the codebase
 * and break unrelated tests).
 */
interface DurableObjectStub {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
import type { Connection, ResourceKey } from "./_broker.node";

export {
  MAX_CONNECTIONS_PER_USER,
  type Connection,
  type ResourceKey,
} from "./_broker.node";

/**
 * Cloudflare Workers Durable Object adapter for the realtime broker.
 *
 * Mirrors the in-memory `Broker` surface used by the self-host code path
 * so call sites (lib/realtime/events.ts, lib/realtime/access.ts,
 * app/api/events/route.ts) stay identical. Each method forwards the
 * intent to the `MYMIR_BROKER` Durable Object via fetch. Connection
 * bookkeeping lives inside the DO; the adapter is stateless across
 * isolates.
 *
 * MYMR-164 ships the adapter as a skeleton — it compiles, binds, and
 * delivers requests to the DO, which returns 501 until the full pub/sub
 * implementation lands. The live realtime path on Workers is intentionally
 * deferred so MYMR-164 stays scoped to scaffolding.
 */
class WorkersBroker {
  /**
   * Resolve the Durable Object stub for a user. Each user maps to a
   * deterministic DO id so the same isolate handles every operation for
   * that user's subscriptions.
   *
   * @param userId - Caller user id.
   * @returns The DO stub keyed by `userId`, or `null` if the binding is
   *   missing (skeleton case).
   */
  private stub(userId: string): DurableObjectStub | null {
    const env = (globalThis as { MYMIR_BROKER?: DurableObjectNamespace })
      .MYMIR_BROKER;
    if (!env) return null;
    const id = env.idFromName(userId);
    return env.get(id);
  }

  /**
   * Send a wire message to the DO. Errors are swallowed — the adapter is
   * fire-and-forget so a single dispatch failure does not break the
   * caller's mutation that already committed.
   *
   * @param userId - DO key.
   * @param msg - Wire payload.
   */
  private async send(userId: string, msg: BrokerMessage): Promise<void> {
    const stub = this.stub(userId);
    if (!stub) return;
    try {
      await stub.fetch("https://broker/", {
        method: "POST",
        body: JSON.stringify(msg),
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("[realtime] WorkersBroker.send failed:", err);
    }
  }

  /**
   * Register a subscription for the user.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   * @param ttlMs - Optional TTL in ms; omit for no expiry.
   */
  register(userId: string, key: ResourceKey, ttlMs?: number): void {
    void this.send(userId, { op: "register", userId, key, ttlMs });
  }

  /**
   * Drop a single subscription early.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   */
  unregister(userId: string, key: ResourceKey): void {
    void this.send(userId, { op: "unregister", userId, key });
  }

  /**
   * Drop every `task:*` subscription for the user.
   *
   * @param userId - Caller user id.
   */
  clearTaskSubs(userId: string): void {
    void this.send(userId, { op: "clear-task-subs", userId });
  }

  /**
   * Attach a live SSE connection for the user. The DO accepts the
   * connection via a separate WebSocket upgrade path in the full
   * implementation; the skeleton no-ops.
   *
   * @param _userId - Caller user id.
   * @param _conn - SSE writer.
   */
  attach(_userId: string, _conn: Connection): void {
    // Skeleton: SSE attach handled via DO WebSocket upgrade in later task.
  }

  /**
   * Atomically check the per-user connection cap and add the connection
   * when room remains.
   *
   * @param _userId - Caller user id.
   * @param _conn - SSE writer.
   * @returns Always `true` in the skeleton.
   */
  tryAttach(_userId: string, _conn: Connection): boolean {
    return true;
  }

  /**
   * Whether the user is at their connection cap.
   *
   * @param _userId - Caller user id.
   * @returns Always `false` in the skeleton.
   */
  isAtConnectionLimit(_userId: string): boolean {
    return false;
  }

  /**
   * Whether the user currently holds at least one SSE connection.
   *
   * @param _userId - Caller user id.
   * @returns Always `false` in the skeleton.
   */
  hasConnections(_userId: string): boolean {
    return false;
  }

  /**
   * Detach a live SSE connection.
   *
   * @param userId - Caller user id.
   * @param _conn - SSE writer to remove.
   */
  detach(userId: string, _conn: Connection): void {
    void this.send(userId, { op: "detach", userId });
  }

  /**
   * Yield user ids currently subscribed to {@link key}. The DO holds the
   * subscription map; the adapter cannot enumerate without an extra
   * round-trip per call. The skeleton yields nothing.
   *
   * @param _key - Resource key to match.
   * @yields Nothing in the skeleton.
   */
  *subscribers(_key: ResourceKey): Iterable<string> {
    // Skeleton: DO-side enumeration RPC lands with the full implementation.
  }

  /**
   * Prune expired subscriptions for the user.
   *
   * @param _userId - Caller user id.
   */
  pruneExpired(_userId: string): void {
    // Skeleton: DO performs pruning internally on each op.
  }

  /**
   * Dispatch a payload to every connection of every subscribed user.
   * Fan-out happens DO-side; the adapter forwards the intent.
   *
   * @param key - Resource key.
   * @param payload - JSON-serializable event body.
   */
  dispatch(key: ResourceKey, payload: unknown): void {
    void this.send("__broadcast__", { op: "dispatch", key, payload });
  }

  /** Test-only — no-op on Workers (state lives in the DO). */
  _resetForTests(): void {
    // Skeleton: covered by a DO `__reset` op in later task.
  }
}

export type Broker = WorkersBroker;

/** Workers broker singleton — instances are cheap; the DO holds the state. */
export const broker: WorkersBroker = new WorkersBroker();
