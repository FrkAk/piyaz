import { test, expect } from "bun:test";
import { GET, POST } from "@/app/api/auth/[...all]/route";

/**
 * Runtime-compatibility guard for the Better Auth catch-all route.
 *
 * `bun test` runs on undici, whose `Request` accepts another Request as its
 * input and copies it. The Cloudflare bundle does not: `@opennextjs/cloudflare`
 * replaces `globalThis.Request`, and the object a route handler receives there
 * fails workerd's native brand check, so the constructor falls through to
 * USVString conversion and throws `TypeError: Invalid URL: [object Request]`.
 * That divergence took every `/api/auth/*` request to 500 on the hosted target
 * while the whole suite stayed green.
 *
 * These tests drive the exported handlers with the global swapped for a
 * constructor carrying the bundle's restriction, so the same mistake fails
 * here instead of in production.
 */

const NativeRequest = globalThis.Request;

/** `Request` carrying the Cloudflare bundle's input restriction. */
class BundleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input !== "string" && !(input instanceof URL)) {
      new URL(String(input));
    }
    super(input, init);
  }
}

/**
 * Run one handler call with the bundle's `Request` installed globally.
 *
 * @param call - Thunk invoking the route handler.
 * @returns The handler's response.
 */
async function underBundleRequest(
  call: () => Promise<Response>,
): Promise<Response> {
  globalThis.Request = BundleRequest as unknown as typeof Request;
  try {
    return await call();
  } finally {
    globalThis.Request = NativeRequest;
  }
}

test("the auth catch-all rebuilds requests the Cloudflare bundle accepts", async () => {
  const response = await underBundleRequest(() =>
    GET(
      new NativeRequest(
        "https://example.test/api/auth/.well-known/oauth-authorization-server",
      ),
    ),
  );

  expect(response.status).toBe(200);
});

test("a rebuilt POST keeps its body and drops the inbound content-length", async () => {
  const body = JSON.stringify({
    email: "workers-shim@test.local",
    password: "wrong-password-12345",
  });
  const response = await underBundleRequest(() =>
    POST(
      new NativeRequest("https://example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A stale length survives onto the rebuilt body unless dropped.
          "content-length": "9999",
          "cf-connecting-ip": "203.0.113.91",
          "x-piyaz-client-ip": "203.0.113.91",
        },
        body,
      }),
    ),
  );

  // Better Auth reached credential checking, which it can only do after
  // parsing the forwarded body; a dropped body answers 400 instead.
  expect(response.status).toBe(401);
});
