import type { ResourceKey } from "./_broker.node";

/**
 * Minimal local shape of `DurableObjectState` — we only need the type
 * positionally in the constructor, not its full surface. Pulling in
 * `@cloudflare/workers-types` globally would override DOM `Response` /
 * `Request` shapes throughout the codebase and break unrelated tests.
 */
type DurableObjectState = unknown;

/**
 * Wire message sent to the `MymirBroker` Durable Object over the
 * `fetch(request)` boundary. The class instance multiplexes per-user
 * subscription state by keying off the DO stub id, which the Workers
 * broker adapter derives from `userId`.
 */
export type BrokerMessage =
  | { op: "register"; userId: string; key: ResourceKey; ttlMs?: number }
  | { op: "unregister"; userId: string; key: ResourceKey }
  | { op: "clear-task-subs"; userId: string }
  | { op: "detach"; userId: string }
  | { op: "dispatch"; key: ResourceKey; payload: unknown };

/**
 * Cloudflare Durable Object that replaces the self-host in-memory broker
 * across Worker isolates. This skeleton compiles and binds correctly so
 * `wrangler dev` boots and the bundle carries the class symbol the
 * `wrangler.jsonc` `durable_objects.bindings` entry references.
 *
 * Full per-team pub/sub semantics (SSE fanout, connection tracking,
 * cross-isolate delivery) are intentionally deferred to a downstream task —
 * MYMR-164 ships the **scaffolding** so the Worker builds and deploys, not
 * the live realtime path. Calls land at {@link fetch} which returns 501
 * until the implementation lands.
 */
export class MymirBroker {
  constructor(_state: DurableObjectState, _env: unknown) {
    // Skeleton: persistent state and SSE WebSocket bookkeeping wire up later.
  }

  /**
   * Handle a wire request from the Workers broker adapter.
   *
   * @param request - Incoming `fetch` carrying a {@link BrokerMessage} body.
   * @returns 501 Not Implemented until the full DO logic lands.
   */
  async fetch(request: Request): Promise<Response> {
    const msg = (await request
      .json()
      .catch(() => null)) as BrokerMessage | null;
    if (!msg) {
      return new Response("Bad request", { status: 400 });
    }
    return new Response(
      JSON.stringify({
        ok: false,
        error: "MymirBroker DO is a skeleton; pub/sub semantics deferred.",
        received: msg.op,
      }),
      {
        status: 501,
        headers: { "content-type": "application/json" },
      },
    );
  }
}
