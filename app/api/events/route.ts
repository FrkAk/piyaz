import { getAuthContext } from "@/lib/auth/context";
import { listAccessibleProjectIds } from "@/lib/data/project";
import { broker, type Connection } from "@/lib/realtime/broker";
import { error } from "@/lib/api/response";

const IS_CLOUDFLARE = process.env.DEPLOY_TARGET === "cloudflare";

/**
 * Per-user SSE endpoint. One connection per browser tab; the broker keys
 * subscriptions on `userId` so a single user can hold many concurrent tabs
 * cheaply. On open the route pre-registers `project:<id>` (no TTL) for every
 * project the user can access plus the user's `project-list:<userId>`
 * channel. `task:<id>` subscriptions are registered lazily by the
 * `GET /api/task/[id]` route on each task fetch with a 10 minute TTL.
 *
 * A per-user concurrent connection cap (`Broker.MAX_CONNECTIONS_PER_USER`)
 * bounds DoS exposure. The pre-`start` `isAtConnectionLimit` read is a
 * fast-path 429; the in-`start` `tryAttach` is the authoritative gate, so
 * concurrent requests cannot exceed the cap.
 *
 * Subscriptions are registered inside the stream's `start` callback (after
 * `attach`) so dispatches racing with the function return don't yield a
 * subscriber-without-connection.
 *
 * The Cloudflare Workers target short-circuits to 204 with `Retry-After`:
 * the self-host in-memory broker is single-process and leaks `subs`/`conns`
 * on Workers because stream `cancel` fires in a dead I/O context so
 * `detach` never runs; the Durable-Object-backed broker is the planned
 * replacement. While disabled, data freshness comes from React Query's
 * `staleTime` + focus-refetch.
 *
 * @param req - Incoming request — only the abort signal is consumed.
 * @returns 200 with `text/event-stream`, 401 when unauthenticated, 429
 *   when the user is at the per-user connection cap, or 204 with
 *   `Retry-After` on the Cloudflare deploy.
 */
export async function GET(req: Request): Promise<Response> {
  if (IS_CLOUDFLARE) {
    return new Response(null, {
      status: 204,
      headers: { "Retry-After": "300" },
    });
  }

  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  const userId = ctx.userId;

  if (broker.isAtConnectionLimit(userId)) {
    return new Response(
      JSON.stringify({ error: "Too many concurrent connections" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5",
        },
      },
    );
  }

  const projectIds = await listAccessibleProjectIds(ctx);

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const conn: Connection = {
        send(data: string) {
          if (closed) return;
          controller.enqueue(enc.encode(data));
        },
        close() {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // Stream already closed by the runtime — nothing to do.
          }
        },
      };

      // `tryAttach` must precede `register` so a dispatch arriving during
      // wiring sees a non-empty connection set for the user. It is also
      // the authoritative cap gate: concurrent requests cannot exceed
      // MAX_CONNECTIONS_PER_USER regardless of how many pass the
      // out-of-band `isAtConnectionLimit` fast-path.
      if (!broker.tryAttach(userId, conn)) {
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
        return;
      }
      for (const id of projectIds) {
        broker.register(userId, `project:${id}`);
      }
      broker.register(userId, `project-list:${userId}`);

      conn.send(`: hello\n\n`);

      const heartbeat = setInterval(() => {
        conn.send(`: heartbeat\n\n`);
        broker.pruneExpired(userId);
      }, 30_000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        broker.detach(userId, conn);
        conn.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
