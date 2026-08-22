import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { JsonFileAccountRegistry } from "./account-registry.js";
import { GmailApi } from "./gmail/api.js";
import { MacOsKeychainGmailCredentialStore } from "./gmail/credentials.js";
import { createDesktopAuthorization, GmailEnrollmentService, GoogleTokenBroker } from "./gmail/oauth.js";

const clientId = required("GOOGLE_OAUTH_CLIENT_ID");
const accountId = required("MCP_MAIL_ACCOUNT_ID");
const label = process.env.MCP_MAIL_ACCOUNT_LABEL ?? accountId;
const roles = process.env.MCP_MAIL_ACCOUNT_ROLES?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
const dataDirectory = process.env.MCP_MAIL_CORE_DATA_DIR ?? join(homedir(), "Library", "Application Support", "mcp-mail-core");
const registry = new JsonFileAccountRegistry(join(dataDirectory, "accounts.json"));
const credentialStore = new MacOsKeychainGmailCredentialStore();
const tokens = new GoogleTokenBroker({ clientId, ...(process.env.GOOGLE_OAUTH_CLIENT_SECRET ? { clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET } : {}) }, credentialStore);

const callback = await receiveAuthorization(clientId);
const enrollment = new GmailEnrollmentService(registry, credentialStore, tokens, { profile: (accessToken) => new GmailApi("enrollment", tokens).profile(accessToken) });
const enrolled = await enrollment.enroll({ accountId, label, roles, code: callback.code, codeVerifier: callback.codeVerifier, redirectUri: callback.redirectUri });
process.stderr.write(`Enrolled ${enrolled.id} (${enrolled.providerIdentity ?? "identity unavailable"}).\n`);

async function receiveAuthorization(oauthClientId: string): Promise<{ code: string; codeVerifier: string; redirectUri: string }> {
  let finish!: (value: { code: string; codeVerifier: string; redirectUri: string }) => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<{ code: string; codeVerifier: string; redirectUri: string }>((resolve, reject) => { finish = resolve; fail = reject; });
  let authorization: ReturnType<typeof createDesktopAuthorization>;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", authorization.redirectUri);
    if (url.searchParams.get("state") !== authorization.state) { response.writeHead(400).end("Invalid OAuth state."); fail(new Error("Google OAuth state mismatch.")); return; }
    const code = url.searchParams.get("code");
    if (!code) { response.writeHead(400).end("Authorization was not completed."); fail(new Error(`Google OAuth failed: ${url.searchParams.get("error") ?? "missing code"}`)); return; }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Gmail account authorized. You can close this tab.");
    finish({ code, codeVerifier: authorization.codeVerifier, redirectUri: authorization.redirectUri });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback OAuth callback.");
  authorization = createDesktopAuthorization({ clientId: oauthClientId }, `http://127.0.0.1:${address.port}/oauth/callback`);
  process.stderr.write(`Open this Google authorization URL if the browser does not open:\n${authorization.authorizationUrl}\n`);
  await promisify(execFile)("open", [authorization.authorizationUrl]);
  try { return await completed; } finally { server.close(); }
}

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required. See README.md.`); return value; }
