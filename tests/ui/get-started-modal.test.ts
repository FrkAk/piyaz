import { expect, test } from "bun:test";

interface CliInstall {
  name: string;
  install: string;
  setupNote: string;
  invocation: string;
  followUp?: { label: string; text: string };
}

interface GetStartedModalModule {
  getCliInstalls?: (
    deployTarget?: string,
    origin?: string,
  ) => readonly CliInstall[];
  getDocsSetupUrl?: (deployTarget?: string) => string;
}

/**
 * Load the modal module through the public alias used by the app.
 *
 * @returns The install-data selectors exported by the modal module.
 */
async function loadGetStartedModalModule(): Promise<{
  getCliInstalls: NonNullable<GetStartedModalModule["getCliInstalls"]>;
  getDocsSetupUrl: NonNullable<GetStartedModalModule["getDocsSetupUrl"]>;
}> {
  const modal = (await import(
    "@/components/home/GetStartedModal"
  )) as GetStartedModalModule;

  expect(typeof modal.getCliInstalls).toBe("function");
  expect(typeof modal.getDocsSetupUrl).toBe("function");
  return {
    getCliInstalls: modal.getCliInstalls as NonNullable<
      GetStartedModalModule["getCliInstalls"]
    >,
    getDocsSetupUrl: modal.getDocsSetupUrl as NonNullable<
      GetStartedModalModule["getDocsSetupUrl"]
    >,
  };
}

/**
 * Flatten install snippets for substring assertions.
 *
 * @param installs - CLI install entries under test.
 * @returns Combined command and setup-note text.
 */
function installText(installs: readonly CliInstall[]): string {
  return installs.map((cli) => `${cli.install}\n${cli.setupNote}`).join("\n");
}

test("hosted deploy shows hosted setup snippets without local checkout paths", async () => {
  const { getCliInstalls, getDocsSetupUrl } = await loadGetStartedModalModule();
  const installs = getCliInstalls("cloudflare");
  const text = installText(installs);

  expect(installs.map((cli) => cli.name)).toEqual([
    "Claude Code",
    "Codex",
    "Antigravity",
    "Cursor",
  ]);
  expect(text).toContain("claude plugin marketplace add FrkAk/piyaz");
  expect(text).toContain("claude plugin install piyaz@piyaz");
  expect(text).toContain("codex plugin marketplace add FrkAk/piyaz");
  expect(text).toContain("https://app.piyaz.ai/api/mcp");
  expect(text).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
  expect(text).not.toContain("./plugins");
  expect(text).not.toContain("localhost");
  expect(text).not.toContain("piyaz-local");
  expect(getDocsSetupUrl("cloudflare")).toContain("docs.piyaz.ai/docs/");
});

test("self-host deploy registers a second server per the run-locally docs", async () => {
  const { getCliInstalls, getDocsSetupUrl } = await loadGetStartedModalModule();
  const installs = getCliInstalls("");
  const text = installText(installs);

  expect(text).toContain("claude plugin marketplace add FrkAk/piyaz");
  expect(text).toContain(
    "claude mcp add -s user --transport http piyaz-self-hosted http://localhost:3000/api/mcp",
  );
  expect(text).toContain("claude mcp login piyaz-self-hosted");
  expect(text).toContain(
    "codex mcp add piyaz-self-hosted --url http://localhost:3000/api/mcp",
  );
  expect(text).toContain("codex mcp login piyaz-self-hosted");
  expect(text).toContain(
    '"piyaz-self-hosted": { "serverUrl": "http://localhost:3000/api/mcp" }',
  );
  expect(text).toContain(
    '"piyaz-self-hosted": { "url": "http://localhost:3000/api/mcp" }',
  );
  expect(text).not.toContain("./plugins");
  expect(text).not.toContain("piyaz-local");
  expect(getDocsSetupUrl("")).toContain("docs.piyaz.ai/docs/guides/self-host");
});

test("self-host snippets substitute the instance origin into every endpoint", async () => {
  const { getCliInstalls } = await loadGetStartedModalModule();
  const installs = getCliInstalls("", "https://piyaz.example.com");
  const commands = installs.map((cli) => cli.install).join("\n");

  expect(commands).toContain("https://piyaz.example.com/api/mcp");
  expect(commands).not.toContain("localhost:3000");
  expect(getCliInstalls("", "http://localhost:3000")).toEqual(
    getCliInstalls(""),
  );
});

test("follow-up notes cover auto-update and the skills installs", async () => {
  const { getCliInstalls } = await loadGetStartedModalModule();

  for (const target of ["cloudflare", ""]) {
    const byName = new Map(
      getCliInstalls(target).map((cli) => [cli.name, cli]),
    );
    expect(byName.get("Claude Code")?.followUp?.text).toContain(
      "Enable auto-update",
    );
    expect(byName.get("Claude Code")?.followUp?.text).toContain(
      "/reload-plugins",
    );
    expect(byName.get("Antigravity")?.followUp?.text).toContain(
      "plugins/antigravity",
    );
    expect(byName.get("Cursor")?.followUp?.text).toContain("Team Marketplaces");
  }
});

test("each harness declares its skill invocation prefix", async () => {
  const { getCliInstalls } = await loadGetStartedModalModule();

  for (const target of ["cloudflare", ""]) {
    for (const cli of getCliInstalls(target)) {
      expect(cli.invocation).toBe(cli.name === "Codex" ? "$piyaz" : "/piyaz");
    }
  }
});
