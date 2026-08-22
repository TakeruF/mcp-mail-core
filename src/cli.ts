import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonFileAccountRegistry } from "./account-registry.js";
import { MacOsKeychainGmailCredentialStore } from "./gmail/credentials.js";
import { GoogleTokenBroker } from "./gmail/oauth.js";
import { GmailProvider } from "./gmail/provider.js";
import { MultiAccountMailService } from "./service.js";
import { buildMailServer } from "./server.js";

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
if (!clientId) throw new Error("GOOGLE_OAUTH_CLIENT_ID is required. See README.md.");
const dataDirectory = process.env.MCP_MAIL_CORE_DATA_DIR ?? join(homedir(), "Library", "Application Support", "mcp-mail-core");
const registry = new JsonFileAccountRegistry(join(dataDirectory, "accounts.json"));
const credentialStore = new MacOsKeychainGmailCredentialStore();
const tokens = new GoogleTokenBroker({ clientId, ...(process.env.GOOGLE_OAUTH_CLIENT_SECRET ? { clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET } : {}) }, credentialStore);
const service = new MultiAccountMailService(registry, [new GmailProvider(tokens)]);
await buildMailServer(service).connect(new StdioServerTransport());
