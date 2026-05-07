import { getAuthContext } from "@/lib/auth/context";
import { listAccessibleProjectIds } from "@/lib/data/project";
import { broker, type Connection } from "@/lib/realtime/broker";
import { error } from "@/lib/api/response";

/**
 * Per-user SSE endpoint. One connection per browser tab; the broker keys
 * subscriptions on `userId` so a single user can hold many concurrent tabs
 * cheaply. On open the route pre-registers `project:<id>` (no TTL) for every
 * project the user can access plus the user's `project-list:<userId>`
 * channel. `task:<id>` subscriptions are registered lazily by the
 * `GET /api/task/[id]` route on each task fetch with a 10 minute TTL.
 *
 * A per-user concurrent connection cap (`Broker.MAX_CONNECTIONS_PER_USER`)
 * bounds DoS exposure — without it a single authenticated user can open
 * unbounded EventSource streams. The check has a small TOCTOU window
 * between this read and the in-`start` `attach`; with cap=20 the worst
 * case is one extra connection, which is acceptable.
 *
 * Subscriptions are registered inside the stream's `start` callback (after
 * `attach`) so dispatches racing with the function return don't yield a
 * subscriber-without-connection.
 *
 * @param req - Incoming request — only the abort signal is consumed.
 * @returns 200 with `text/event-stream`, 401 when unauthenticated, or 429
 *   when the user is at the per-user connection cap.
 */
export async function GET(req: Request): Promise<Response> {
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

      // Order matters: attach BEFORE register so any dispatch that fires
      // while we're still wiring up sees a non-empty connection set for
      // this user. Otherwise the `subscribers()` lookup yields the user
      // but `conns.get(userId)` returns undefined and the event is
      // silently dropped for that tab.
      broker.attach(userId, conn);
      for (const id of projectIds) {
        broker.register(userId, `project:${id}`);
      }
      broker.register(userId, `project-list:${userId}`);

      conn.send(`: hello\n\n`);

      const heartbeat = setInterval(() => {
        conn.send(`: heartbeat\n\n`);
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
