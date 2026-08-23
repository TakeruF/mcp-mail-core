import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccountRegistry } from "./account-registry.js";
import type { MailProviderAdapter } from "./provider.js";
import { buildMailServer } from "./server.js";
import { MultiAccountMailService } from "./service.js";

export type MailHostOptions = Readonly<{
  registry: AccountRegistry;
  providers: readonly MailProviderAdapter[];
  cursorSecret: Uint8Array;
}>;

export type MailHost = Readonly<{
  service: MultiAccountMailService;
  server: McpServer;
}>;

/**
 * Provider-neutral composition seam. Provider packages retain credential and
 * transport ownership and inject already-configured adapters here.
 */
export function createMailHost(options: MailHostOptions): MailHost {
  const service = new MultiAccountMailService(options.registry, options.providers, options.cursorSecret);
  return Object.freeze({ service, server: buildMailServer(service) });
}
