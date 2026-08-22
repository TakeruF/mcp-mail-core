import { homedir } from "node:os";
import { join } from "node:path";
import { JsonFileAccountRegistry } from "./account-registry.js";
import { loadOrCreateCursorSecret } from "./cursor.js";
import { MacOsKeychainGmailCredentialStore } from "./gmail/credentials.js";
import { GoogleTokenBroker } from "./gmail/oauth.js";
import { GmailProvider } from "./gmail/provider.js";
import { MultiAccountMailService } from "./service.js";

const clientId = required("GOOGLE_OAUTH_CLIENT_ID");
const dataDirectory = process.env.MCP_MAIL_CORE_DATA_DIR ?? join(homedir(), "Library", "Application Support", "mcp-mail-core");
const registry = new JsonFileAccountRegistry(join(dataDirectory, "accounts.json"));
const cursorSecret = await loadOrCreateCursorSecret(join(dataDirectory, "cursor.key"));
const credentialStore = new MacOsKeychainGmailCredentialStore();
const tokens = new GoogleTokenBroker({ clientId, ...(process.env.GOOGLE_OAUTH_CLIENT_SECRET ? { clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET } : {}) }, credentialStore);
const service = new MultiAccountMailService(registry, [new GmailProvider(tokens)], cursorSecret);
const selected = process.env.MCP_MAIL_ACCOUNT_ID ? [process.env.MCP_MAIL_ACCOUNT_ID] : undefined;
process.stdout.write(`${JSON.stringify(await service.refreshAccountHealth(selected), null, 2)}\n`);

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required. See README.md.`); return value; }
