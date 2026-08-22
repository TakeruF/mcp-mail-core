import { describe, expect, it, vi } from "vitest";
import { GoogleTokenBroker, InMemoryGmailCredentialStore, MailError, createDesktopAuthorization } from "../src/index.js";

describe("Google OAuth", () => {
  it("creates independent PKCE enrollment requests with offline consent", () => {
    const first = createDesktopAuthorization({ clientId: "client" }, "http://127.0.0.1:49152/oauth/callback");
    const second = createDesktopAuthorization({ clientId: "client" }, "http://127.0.0.1:49153/oauth/callback");
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    const url = new URL(first.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline"); expect(url.searchParams.get("prompt")).toContain("consent"); expect(url.searchParams.get("prompt")).toContain("select_account"); expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("refreshes only the selected credential and preserves its refresh token", async () => {
    const store = new InMemoryGmailCredentialStore();
    await store.put("one", { refreshToken: "refresh-one", grantedScopes: ["scope"] });
    await store.put("two", { refreshToken: "refresh-two", accessToken: "still-valid", expiresAt: Date.now() + 3_600_000, grantedScopes: ["scope"] });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => { expect(String(init?.body)).toContain("refresh-one"); return response({ access_token: "new-one", expires_in: 3600, scope: "scope" }); });
    const broker = new GoogleTokenBroker({ clientId: "client" }, store, fetchMock as typeof fetch);
    expect(await broker.accessToken("one")).toBe("new-one"); expect(await broker.accessToken("two")).toBe("still-valid");
    expect((await store.get("one"))?.refreshToken).toBe("refresh-one"); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps invalid_grant to reauthorization instead of retrying or overwriting", async () => {
    const store = new InMemoryGmailCredentialStore(); await store.put("revoked", { refreshToken: "old", grantedScopes: [] });
    const broker = new GoogleTokenBroker({ clientId: "client" }, store, vi.fn(async () => response({ error: "invalid_grant" }, 400)) as typeof fetch);
    await expect(broker.accessToken("revoked")).rejects.toEqual(expect.objectContaining<Partial<MailError>>({ code: "REAUTHORIZATION_REQUIRED" }));
    expect((await store.get("revoked"))?.refreshToken).toBe("old");
  });
});
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
