import { expect, test } from "bun:test";
import { auth } from "@/lib/auth";
import {
  getMcpResource,
  getOAuthResourceIdentifiers,
} from "@/lib/auth/oauth-resource";

interface OAuthProviderOptions {
  resources?: readonly string[];
  clientRegistrationDefaultResources?: readonly string[];
  clientRegistrationAllowedResources?: readonly string[];
  enforcePerClientResources?: boolean;
  validAudiences?: unknown;
  silenceWarnings?: unknown;
}

test("Better Auth 1.7 keeps atomic secondary-storage paths off KV", async () => {
  const context = await auth.$context;
  expect(context.options.verification?.storeInDatabase).toBe(true);
  expect(context.options.rateLimit?.storage).toBe("memory");
  expect(context.options.advanced?.backgroundTasks?.handler).toBeFunction();
});

test("OAuth Provider 1.7 uses explicit compatibility resources", async () => {
  const context = await auth.$context;
  const plugin = context.options.plugins?.find(
    (candidate) => candidate.id === "oauth-provider",
  );
  const options = plugin?.options as OAuthProviderOptions | undefined;

  expect(options).toBeDefined();
  expect(options?.resources).toEqual(getOAuthResourceIdentifiers());
  expect(options?.clientRegistrationDefaultResources).toEqual([
    getMcpResource(),
  ]);
  expect(options?.clientRegistrationAllowedResources).toEqual(
    getOAuthResourceIdentifiers(),
  );
  expect(options?.enforcePerClientResources).toBe(false);
  expect(options?.validAudiences).toBeUndefined();
  expect(options?.silenceWarnings).toBeUndefined();
});
