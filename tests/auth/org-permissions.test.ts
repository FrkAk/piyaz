import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { auth } from "@/lib/auth";

/**
 * Narrow-catch tests for `isOrgAdmin` / `isOrgOwner`. Pins the H4 fix:
 * the helper must surface `false` only for the documented "not a member"
 * Better Auth code, and rethrow any other thrown body code (transient
 * driver failure, BA serialization regression, header context issue) so
 * the caller can log + fail closed rather than silently masking as
 * `forbidden`.
 *
 * The helper resolves the BA `auth.api.hasPermission` call against the
 * request headers; `next/headers` is mocked at file-top (process-wide
 * but stable across the suite) and `auth.api.hasPermission` is spied on
 * via `spyOn` in `beforeAll` so it can be restored in `afterAll` —
 * keeping the real `@/lib/auth` instance available to other test files
 * in the same `bun test` invocation. `mock.module("@/lib/auth", ...)`
 * is unrestoreable per Bun docs and would block any test that needs
 * the real BA handler (e.g. `tests/auth/cookie-attributes.test.ts`).
 */

type HasPermissionImpl = () => Promise<{ success: boolean }>;

let nextHasPermission: HasPermissionImpl = async () => ({ success: false });
let hasPermissionSpy: ReturnType<typeof spyOn>;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

beforeAll(() => {
  hasPermissionSpy = spyOn(
    auth.api as unknown as { hasPermission: HasPermissionImpl },
    "hasPermission",
  ).mockImplementation(() => nextHasPermission());
});

afterAll(() => {
  hasPermissionSpy.mockRestore();
});

beforeEach(() => {
  nextHasPermission = async () => ({ success: false });
});

afterEach(() => {
  nextHasPermission = async () => ({ success: false });
});

const TARGET_ORG = "11111111-1111-1111-1111-111111111111";

async function load(): Promise<typeof import("@/lib/auth/org-permissions")> {
  return await import("@/lib/auth/org-permissions");
}

describe("isOrgAdmin — narrow catch (H4)", () => {
  test("returns false when BA throws USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION", async () => {
    nextHasPermission = async () => {
      throw { body: { code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION" } };
    };
    const { isOrgAdmin } = await load();
    expect(await isOrgAdmin(TARGET_ORG)).toBe(false);
  });

  test("rethrows when BA throws USER_IS_NOT_VERIFIED", async () => {
    nextHasPermission = async () => {
      throw { body: { code: "USER_IS_NOT_VERIFIED" } };
    };
    const { isOrgAdmin } = await load();
    let caught: unknown;
    try {
      await isOrgAdmin(TARGET_ORG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { body: { code: string } }).body.code).toBe(
      "USER_IS_NOT_VERIFIED",
    );
  });

  test("rethrows when BA throws an Error with no body code", async () => {
    nextHasPermission = async () => {
      throw new Error("transient driver failure");
    };
    const { isOrgAdmin } = await load();
    let caught: unknown;
    try {
      await isOrgAdmin(TARGET_ORG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("transient driver failure");
  });

  test("returns true when BA returns { success: true }", async () => {
    nextHasPermission = async () => ({ success: true });
    const { isOrgAdmin } = await load();
    expect(await isOrgAdmin(TARGET_ORG)).toBe(true);
  });

  test("returns false when BA returns { success: false }", async () => {
    nextHasPermission = async () => ({ success: false });
    const { isOrgAdmin } = await load();
    expect(await isOrgAdmin(TARGET_ORG)).toBe(false);
  });
});

describe("isOrgOwner — narrow catch (H4)", () => {
  test("returns false when BA throws USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION", async () => {
    nextHasPermission = async () => {
      throw { body: { code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION" } };
    };
    const { isOrgOwner } = await load();
    expect(await isOrgOwner(TARGET_ORG)).toBe(false);
  });

  test("rethrows when BA throws USER_IS_NOT_VERIFIED", async () => {
    nextHasPermission = async () => {
      throw { body: { code: "USER_IS_NOT_VERIFIED" } };
    };
    const { isOrgOwner } = await load();
    let caught: unknown;
    try {
      await isOrgOwner(TARGET_ORG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { body: { code: string } }).body.code).toBe(
      "USER_IS_NOT_VERIFIED",
    );
  });

  test("rethrows when BA throws an Error with no body code", async () => {
    nextHasPermission = async () => {
      throw new Error("transient driver failure");
    };
    const { isOrgOwner } = await load();
    let caught: unknown;
    try {
      await isOrgOwner(TARGET_ORG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("transient driver failure");
  });

  test("returns true when BA returns { success: true }", async () => {
    nextHasPermission = async () => ({ success: true });
    const { isOrgOwner } = await load();
    expect(await isOrgOwner(TARGET_ORG)).toBe(true);
  });

  test("returns false when BA returns { success: false }", async () => {
    nextHasPermission = async () => ({ success: false });
    const { isOrgOwner } = await load();
    expect(await isOrgOwner(TARGET_ORG)).toBe(false);
  });
});
