import { homedir } from "node:os";
import { join } from "node:path";
import { JsonFileAccountRegistry } from "./account-registry.js";
import { MacOsKeychainGmailCredentialStore } from "./gmail/credentials.js";
import { GmailEnrollmentService, GoogleTokenBroker } from "./gmail/oauth.js";

const accountId = required("MCP_MAIL_ACCOUNT_ID");
if (process.env.MCP_MAIL_CONFIRM_REMOVE !== "true") {
  throw new Error("Account removal requires MCP_MAIL_CONFIRM_REMOVE=true in the same command.");
}
const clientId = required("GOOGLE_OAUTH_CLIENT_ID");
const dataDirectory = process.env.MCP_MAIL_CORE_DATA_DIR ?? join(homedir(), "Library", "Application Support", "mcp-mail-core");
const registry = new JsonFileAccountRegistry(join(dataDirectory, "accounts.json"));
const credentialStore = new MacOsKeychainGmailCredentialStore();
const tokens = new GoogleTokenBroker({ clientId, ...(process.env.GOOGLE_OAUTH_CLIENT_SECRET ? { clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET } : {}) }, credentialStore);
const enrollment = new GmailEnrollmentService(registry, credentialStore, tokens, { profile: () => Promise.reject(new Error("Profile lookup is not used during removal.")) });
await enrollment.remove(accountId, process.env.MCP_MAIL_SKIP_REVOCATION !== "true");
process.stderr.write(`Removed Gmail account '${accountId}'${process.env.MCP_MAIL_SKIP_REVOCATION === "true" ? " without remote token revocation" : " and requested Google token revocation"}.\n`);

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required. See README.md.`); return value; }
