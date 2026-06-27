import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { appUserConnect, seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";

afterEach(async () => {
  await truncateAll();
});

/** Resolve an oauth client name as a given user via the SECURITY DEFINER SDF. */
async function clientNameAs(
  userId: string,
  clientId: string,
): Promise<string | null> {
  const c = appUserConnect();
  try {
    const rows = await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return await tx<{ name: string | null }[]>`
        SELECT public.oauth_client_name(${clientId}) AS name`;
    });
    return rows[0].name;
  } finally {
    await c.end({ timeout: 5 });
  }
}

describe("oauth_client_name membership gate", () => {
  test("a member resolves the harness name; a non-member gets null", async () => {
    const owner = await seedUserOrgProject("ocn-owner");
    const stranger = await seedUserOrgProject("ocn-stranger");
    const su = superuserPool();
    try {
      await su`
        INSERT INTO piyaz_auth."oauthClient" ("clientId", name, "redirectUris")
        VALUES ('client-x', 'Owner Harness', '{}')`;
      const [t] = await su<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${owner.projectId}, 'T', 1) RETURNING id`;
      await su`
        INSERT INTO activity_events
          (project_id, task_id, type, source, actor_client_id, summary)
        VALUES (${owner.projectId}, ${t.id}, 'title_changed', 'mcp',
                'client-x', 'x')`;
    } finally {
      await su.end({ timeout: 5 });
    }

    // A member who can already see the event resolves the display name.
    expect(await clientNameAs(owner.userId, "client-x")).toBe("Owner Harness");
    // A non-member of the event's org learns nothing, even knowing the clientId.
    expect(await clientNameAs(stranger.userId, "client-x")).toBeNull();
  });
});
