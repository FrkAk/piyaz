import "server-only";

import type { BrokerMessage } from "./broker-do";
import type { Connection, ResourceKey } from "./_broker.node";

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

/** Module-scoped flag so the missing-binding warning fires once per isolate. */
let warnedMissingBinding = false;

/**
 * Cloudflare Workers Durable Object adapter for the realtime broker. Routes
 * every subscription mutation and dispatch to a single global DO instance
 * via fetch RPC; provides {@link WorkersBroker.connect} for SSE handlers to
 * obtain a WebSocket end of the DO connection. Per-isolate stateless —
 * authoritative state lives in the DO.
 */
class WorkersBroker {
  /**
   * Resolve the stub for the broker-global DO. Logs once per isolate when
   * the binding is missing so misconfigured deploys are diagnosable without
   * spamming.
   *
   * @returns The DO stub, or `null` when `MYMIR_BROKER` is not bound.
   */
  private stub(): DurableObjectStub | null {
    const env = (globalThis as { MYMIR_BROKER?: DurableObjectNamespace })
      .MYMIR_BROKER;
    if (!env) {
      if (!warnedMissingBinding) {
        console.error(
          "[realtime] MYMIR_BROKER binding missing — realtime fanout will silently no-op",
        );
        warnedMissingBinding = true;
      }
      return null;
    }
    const id = env.idFromName(BROKER_DO_NAME);
    return env.get(id);
  }

  /**
   * Send a wire message to the broker DO. Errors are swallowed so a
   * transient DO failure does not break the caller's mutation that already
   * committed; the failing op is included in the log for diagnosis.
   *
   * @param msg - Wire payload.
   */
  private async send(msg: BrokerMessage): Promise<void> {
    const stub = this.stub();
    if (!stub) return;
    try {
      await stub.fetch("https://broker/", {
        method: "POST",
        body: JSON.stringify(msg),
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      console.error("[realtime] broker send failed:", err, { op: msg.op });
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
    void this.send({ op: "register", userId, key, ttlMs });
  }

  /**
   * Drop a single subscription early.
   *
   * @param userId - Caller user id.
   * @param key - Resource key.
   */
  unregister(userId: string, key: ResourceKey): void {
    void this.send({ op: "unregister", userId, key });
  }

  /**
   * Drop every `task:*` subscription for the user.
   *
   * @param userId - Caller user id.
   */
  clearTaskSubs(userId: string): void {
    void this.send({ op: "clear-task-subs", userId });
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
    void this.send({ op: "detach", userId });
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
    void this.send({ op: "dispatch", key, payload });
  }

  /**
   * Open a WebSocket end of the broker DO for the given user. The caller
   * (SSE route, deferred to MYMR-167) is expected to pipe the WebSocket's
   * incoming frames into the SSE response stream.
   *
   * @param userId - Caller user id; attached as the DO-side tag.
   * @returns The client end of the WebSocket pair.
   * @throws When the binding is missing or the DO rejects the upgrade.
   */
  async connect(userId: string): Promise<WebSocket> {
    const stub = this.stub();
    if (!stub) {
      throw new Error(
        "MymirBroker binding missing — cannot open WebSocket to DO",
      );
    }
    const resp = await stub.fetch("https://broker/", {
      headers: {
        Upgrade: "websocket",
        "X-Mymir-User-Id": userId,
      },
    });
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
