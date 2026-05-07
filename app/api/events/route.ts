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
 * @param req - Incoming request — only the abort signal is consumed.
 * @returns 200 with `text/event-stream` or 401 when unauthenticated.
 */
export async function GET(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch {
    return error("Unauthorized", 401);
  }

  const userId = ctx.userId;
  const projectIds = await listAccessibleProjectIds(ctx);

  for (const id of projectIds) {
    broker.register(userId, `project:${id}`);
  }
  broker.register(userId, `project-list:${userId}`);

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

      broker.attach(userId, conn);
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
