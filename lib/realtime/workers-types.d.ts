/**
 * Ambient type stubs for the workerd surface the broker DO touches.
 *
 * The ESLint config bans `@cloudflare/workers-types` imports (its global
 * ambient declarations clobber DOM `Request` / `Response` types and break
 * unrelated tests). This file is the local replacement: only the
 * structural shapes the DO calls into are declared, and the bundle output
 * from `scripts/postbuild-cf.ts` keeps `cloudflare:workers` external so
 * workerd resolves it at runtime.
 *
 * No top-level `import` / `export` so the file is an ambient script,
 * letting `declare module "cloudflare:workers"` declare (not augment) the
 * virtual module.
 */

/** Minimal hibernation-API WebSocket end. */
interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Minimal `DurableObjectState` shape — only methods the broker calls. */
interface DurableObjectStateLike {
  acceptWebSocket(ws: WebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocketLike[];
  getTags(ws: WebSocketLike): string[];
}

/** Local declaration of workerd's `WebSocketPair` global. */
declare const WebSocketPair: {
  new (): { 0: WebSocketLike; 1: WebSocketLike };
};

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectStateLike;
    protected env: Env;
    constructor(ctx: DurableObjectStateLike, env: Env);
  }
}
