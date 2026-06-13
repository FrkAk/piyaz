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
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
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

/**
 * Ambient shims for `@opennextjs/cloudflare`. The package is a Workers-only
 * devDependency, so `bun install --production` on a self-host install does
 * not include it. The webpack alias in `next.config.ts` ensures the files
 * that import from this module are never loaded on self-host runtime; the
 * shims below only need to satisfy the build-time typecheck. When the real
 * package is installed (regular `bun install`), TypeScript prefers the
 * package's own declarations from `node_modules/@opennextjs/cloudflare`.
 */
declare module "@opennextjs/cloudflare" {
  export function getCloudflareContext(options?: { async?: boolean }): {
    ctx: { waitUntil: (promise: Promise<unknown>) => void };
    env: unknown;
    cf?: unknown;
  };
  export function initOpenNextCloudflareForDev(): void;
  export function defineCloudflareConfig(config: unknown): unknown;
}

declare module "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache" {
  const r2IncrementalCache: unknown;
  export default r2IncrementalCache;
}

declare module "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache" {
  const d1NextTagCache: unknown;
  export default d1NextTagCache;
}

declare module "@opennextjs/cloudflare/overrides/queue/do-queue" {
  const doQueue: unknown;
  export default doQueue;
}
