import { describe, expect, it } from "vitest";
import { GmailApi, GoogleTokenBroker, MacOsKeychainGmailCredentialStore } from "../../src/index.js";

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const credentialId = process.env.MCP_MAIL_LIVE_CREDENTIAL_ID;
const live = Boolean(clientId && credentialId && process.env.MCP_MAIL_RUN_LIVE === "true");

describe.skipIf(!live)("Gmail opt-in live smoke test", () => {
  it("reads the authorized profile and a metadata-only one-message page", async () => {
    const store = new MacOsKeychainGmailCredentialStore();
    const tokens = new GoogleTokenBroker({ clientId: clientId! }, store);
    const api = new GmailApi(credentialId!, tokens);
    const profile = await api.profile();
    expect(profile.emailAddress).toContain("@");
    const page = await api.listMessages({ maxResults: 1 });
    expect(page.messages?.length ?? 0).toBeLessThanOrEqual(1);
    if (page.messages?.[0]) {
      const metadata = await api.getMessage(page.messages[0].id, "metadata");
      expect(metadata.id).toBe(page.messages[0].id);
    }
  });
});
