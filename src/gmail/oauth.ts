import { createHash, randomBytes } from "node:crypto";
import type { AccountRegistry } from "../account-registry.js";
import type { RegisteredAccount } from "../domain.js";
import { MailError } from "../errors.js";
import type { GmailCredentialStore, GmailCredentials } from "./credentials.js";
import { GMAIL_CAPABILITIES } from "./provider.js";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
// gmail.modify is the narrowest single scope that covers this adapter's reads,
// drafts, sends, label changes, archive, and Trash while excluding permanent delete.
export const GMAIL_DEFAULT_SCOPES = Object.freeze([GMAIL_MODIFY_SCOPE]);

export type GoogleOAuthClient = Readonly<{ clientId: string; clientSecret?: string }>;
export type PkceAuthorization = Readonly<{ authorizationUrl: string; codeVerifier: string; state: string; redirectUri: string }>;

export function createDesktopAuthorization(client: GoogleOAuthClient, redirectUri: string, scopes = GMAIL_DEFAULT_SCOPES): PkceAuthorization {
  const codeVerifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: "code",
    scope: scopes.join(" "), access_type: "offline", include_granted_scopes: "true",
    prompt: "consent select_account", code_challenge: challenge, code_challenge_method: "S256", state,
  }).toString();
  return { authorizationUrl: url.toString(), codeVerifier, state, redirectUri };
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

export class GoogleTokenBroker {
  readonly #refreshing = new Map<string, Promise<string>>();
  public constructor(private readonly client: GoogleOAuthClient, private readonly store: GmailCredentialStore, private readonly fetchImpl: typeof fetch = fetch) {}

  public async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GmailCredentials> {
    const response = await this.tokenRequest({ code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri, grant_type: "authorization_code" });
    if (!response.refresh_token) throw new MailError("AUTHENTICATION_FAILED", "Google did not return a refresh token. Reauthorize with consent.");
    return toCredentials(response);
  }

  public async accessToken(credentialId: string): Promise<string> {
    const credentials = await this.store.get(credentialId);
    if (!credentials) throw new MailError("REAUTHORIZATION_REQUIRED", "Gmail credentials are missing.");
    if (credentials.accessToken && (credentials.expiresAt ?? 0) > Date.now() + 60_000) return credentials.accessToken;
    const active = this.#refreshing.get(credentialId);
    if (active) return active;
    const refresh = this.refresh(credentialId, credentials).finally(() => this.#refreshing.delete(credentialId));
    this.#refreshing.set(credentialId, refresh);
    return refresh;
  }

  public async revoke(credentialId: string): Promise<void> {
    const credentials = await this.store.get(credentialId);
    if (credentials) {
      const response = await this.fetchImpl("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credentials.refreshToken }) });
      if (!response.ok && response.status !== 400) throw new MailError("PROVIDER_UNAVAILABLE", "Google token revocation failed.", true);
    }
    await this.store.delete(credentialId);
  }

  private async refresh(id: string, current: GmailCredentials): Promise<string> {
    let response: TokenResponse;
    try { response = await this.tokenRequest({ refresh_token: current.refreshToken, grant_type: "refresh_token" }); }
    catch (error) {
      if (error instanceof MailError && error.code === "REAUTHORIZATION_REQUIRED") throw error;
      throw error;
    }
    const updated: GmailCredentials = {
      refreshToken: response.refresh_token ?? current.refreshToken,
      accessToken: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      grantedScopes: response.scope?.split(" ").filter(Boolean) ?? current.grantedScopes,
    };
    await this.store.put(id, updated, { overwrite: true });
    return response.access_token;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({ ...fields, client_id: this.client.clientId, ...(this.client.clientSecret ? { client_secret: this.client.clientSecret } : {}) });
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const json = await response.json() as TokenResponse & { error?: string };
    if (!response.ok) {
      if (json.error === "invalid_grant") throw new MailError("REAUTHORIZATION_REQUIRED", "Gmail authorization was revoked or expired.");
      throw new MailError("AUTHENTICATION_FAILED", "Google OAuth token exchange failed.", response.status >= 500);
    }
    return json;
  }
}

export class GmailEnrollmentService {
  public constructor(private readonly registry: AccountRegistry, private readonly credentials: GmailCredentialStore, private readonly tokens: GoogleTokenBroker, private readonly api: { profile(accessToken: string): Promise<{ emailAddress: string }> }) {}
  public async enroll(input: { accountId: string; label: string; roles?: readonly string[]; code: string; codeVerifier: string; redirectUri: string }): Promise<RegisteredAccount> {
    if (await this.registry.get(input.accountId)) throw new MailError("INVALID_INPUT", `Account '${input.accountId}' already exists.`);
    const credentialId = `gmail:${input.accountId}`;
    const credential = await this.tokens.exchangeCode(input);
    await this.credentials.put(credentialId, credential);
    try {
      const profile = await this.api.profile(credential.accessToken ?? await this.tokens.accessToken(credentialId));
      const account: RegisteredAccount = { id: input.accountId, provider: "gmail", label: input.label, roles: input.roles ?? [], capabilities: GMAIL_CAPABILITIES, status: "ready", providerIdentity: profile.emailAddress, credentialId };
      await this.registry.add(account);
      return account;
    } catch (error) {
      await this.credentials.delete(credentialId);
      throw error;
    }
  }
  public async remove(accountId: string, revoke = true): Promise<void> {
    const account = await this.registry.get(accountId);
    if (!account || account.provider !== "gmail") throw new MailError("ACCOUNT_NOT_FOUND", `Gmail account '${accountId}' was not found.`);
    if (revoke) await this.tokens.revoke(account.credentialId); else await this.credentials.delete(account.credentialId);
    await this.registry.remove(accountId);
  }
}

function toCredentials(token: TokenResponse): GmailCredentials {
  if (!token.refresh_token) throw new MailError("AUTHENTICATION_FAILED", "No refresh token was returned.");
  return { refreshToken: token.refresh_token, accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000, grantedScopes: token.scope?.split(" ").filter(Boolean) ?? [] };
}
