import { describe, expect, it, vi } from "vitest";
import { GmailApi, GmailProvider, GoogleTokenBroker, InMemoryGmailCredentialStore, composeMime, gmailQuery, type ProviderContext } from "../src/index.js";

const context: ProviderContext = { account: { id: "gmail-personal", provider: "gmail", label: "Personal", roles: ["personal"], status: "ready", providerIdentity: "me@example.com", capabilities: { search: true, nativeSearch: true, threads: "native", labels: true, folders: false, attachments: true, drafts: true, send: true, reply: true, forward: true, archive: true, trash: true, permanentDelete: false, flags: ["read", "starred"] } }, credentialId: "gmail:gmail-personal" };

describe("Gmail provider", () => {
  it("enforces MIME safety bounds at the provider boundary", () => {
    expect(() => composeMime({ to: ["a@example.com"], subject: "safe", text: "body", attachments: [{ filename: "note.txt", contentType: "text/plain\r\nBcc: victim@example.com", contentBase64: "YQ==" }] })).toThrow("simple MIME media type");
    const escaped = composeMime({ to: ["a@example.com"], subject: "safe", text: "body", attachments: [{ filename: 'quote"name.txt', contentType: "text/plain", contentBase64: "YQ==" }] });
    expect(escaped).toContain('filename="quote\\"name.txt"');
    expect(() => composeMime({ to: ["a@example.com"], subject: "x".repeat(999), text: "body" })).toThrow("998");
    expect(() => composeMime({ to: ["a@example.com"], subject: "safe", text: "body", attachments: Array.from({ length: 11 }, (_, index) => ({ filename: `${index}.txt`, contentBase64: "YQ==" })) })).toThrow("10 attachments");
    expect(() => composeMime({ to: Array.from({ length: 60 }, (_, index) => `to${index}@example.com`), cc: Array.from({ length: 41 }, (_, index) => `cc${index}@example.com`), subject: "safe", text: "body" })).toThrow("100 total recipients");
    expect(() => composeMime({ to: ["not-an-address"], subject: "safe", text: "body" })).toThrow("valid email");
    expect(() => composeMime({ to: ["a@example.com"], subject: "safe", text: "body", attachments: [{ filename: "../secret.txt", contentBase64: "YQ==" }] })).toThrow("plain names");
  });

  it("bounds Gmail network time and response bytes", async () => {
    const timeoutFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("timed out", "AbortError");
    });
    const timeoutTokens = await tokensWithFetch(timeoutFetch as typeof fetch);
    const timeoutApi = new GmailApi("gmail:gmail-personal", timeoutTokens, timeoutFetch as typeof fetch, undefined, undefined, { requestTimeoutMs: 1 });
    await expect(timeoutApi.profile()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });

    const largeFetch = vi.fn(async () => response({ emailAddress: "much-too-large@example.com" }));
    const largeTokens = await tokensWithFetch(largeFetch as typeof fetch);
    const boundedApi = new GmailApi("gmail:gmail-personal", largeTokens, largeFetch as typeof fetch, undefined, undefined, { maxResponseBytes: 16 });
    await expect(boundedApi.profile()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
  it("preserves native query, labels, dates, unread, and attachment filters", () => {
    expect(gmailQuery({ nativeQuery: "newer_than:7d", text: "OpenAI", labels: ["university"], unread: true, hasAttachment: true, after: "2026/08/01" })).toBe("newer_than:7d OpenAI after:2026/08/01 is:unread has:attachment label:university");
  });

  it("searches with Gmail pagination and returns thread, labels, and provenance-ready IDs", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input); requests.push(url);
      if (url.includes("/messages?")) return response({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "next" });
      return response(message("m1", "t1", ["INBOX", "UNREAD", "STARRED"]));
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    const page = await adapter.search(context, { nativeQuery: "from:openai.com" }, undefined, 10);
    expect(page.nextCursor).toBe("next");
    expect(page.messages[0]).toMatchObject({ providerMessageId: "m1", providerThreadId: "t1", labels: ["INBOX", "UNREAD", "STARRED"], unread: true, starred: true });
    expect(requests[0]).toContain("q=from%3Aopenai.com");
  });

  it("retries bounded idempotent reads after a transient Gmail response", async () => {
    let listAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/messages?")) {
        listAttempts += 1;
        if (listAttempts === 1) return new Response(JSON.stringify({ error: "rateLimitExceeded" }), { status: 429, headers: { "retry-after": "0" } });
        return response({ messages: [{ id: "m1" }] });
      }
      return response(message("m1", "t1", []));
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    expect((await adapter.search(context, {}, undefined, 1)).messages).toHaveLength(1);
    expect(listAttempts).toBe(2);
  });

  it("does not automatically retry non-idempotent sends", async () => {
    let sendAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/messages/send")) {
        sendAttempts += 1;
        return response({ error: "backendError" }, 503);
      }
      return response(message("m1", "t1", []));
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    await expect(adapter.send(context, { to: ["a@example.com"], subject: "Once", text: "body" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(sendAttempts).toBe(1);
  });

  it("handles native threads, body parsing, and attachments", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/threads/t1")) return response({ messages: [message("m1", "t1", [])] });
      if (url.includes("/attachments/a1")) return response({ data: Buffer.from("file").toString("base64url"), size: 4 });
      return response(message("m1", "t1", []));
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    const detail = await adapter.getMessage(context, "m1");
    expect(detail.bodyText).toBe("hello");
    expect(detail.attachments[0]).toMatchObject({ attachmentId: "a1", filename: "note.txt" });
    expect((await adapter.getThread(context, "t1")).messages).toHaveLength(1);
    expect((await adapter.getAttachment(context, "m1", "a1")).contentBase64).toBe(Buffer.from("file").toString("base64"));
  });

  it("checks actual attachment bytes even when Gmail underreports size", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64url");
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes("/attachments/a1") ? response({ data: oversized, size: 1 }) : response(message("m1", "t1", [])));
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    await expect(adapter.getAttachment(context, "m1", "a1")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("creates, updates, sends drafts and sends correctly threaded replies", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.endsWith("/drafts/send")) return response({ id: "sent-draft", threadId: "t1" });
      if (url.includes("/drafts/d1")) return response({ id: "d1", message: { id: "draft-message-2" } });
      if (url.endsWith("/drafts")) return response({ id: "d1", message: { id: "draft-message" } });
      if (url.endsWith("/messages/send")) return response({ id: "reply", threadId: "t1" });
      return response(message("m1", "t1", []));
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    expect(await adapter.createDraft(context, { to: ["a@example.com"], subject: "Draft", text: "body" })).toMatchObject({ providerDraftId: "d1" });
    expect(await adapter.updateDraft(context, "d1", { to: ["a@example.com"], subject: "Draft 2", text: "body" })).toMatchObject({ providerMessageId: "draft-message-2", previousDraftDisposition: "provider-managed" });
    expect(await adapter.sendDraft(context, "d1")).toMatchObject({ providerMessageId: "sent-draft", draftDisposition: "provider-managed" });
    const original = await adapter.getMessage(context, "m1");
    await adapter.reply(context, original, { text: "reply" });
    const replyBody = JSON.parse(calls.find((call) => call.url.endsWith("/messages/send"))?.body ?? "{}") as { raw: string; threadId: string };
    expect(replyBody.threadId).toBe("t1");
    expect(Buffer.from(replyBody.raw, "base64url").toString()).toContain("In-Reply-To: <m1@example.com>");
  });

  it("honors Reply-To and builds a deduplicated reply-all without the source account", async () => {
    const sentBodies: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/messages/send")) { sentBodies.push(String(init?.body)); return response({ id: "reply", threadId: "t1" }); }
      const value = message("m1", "t1", []);
      value.payload.headers.push(
        { name: "From", value: '"Sender, Primary" <sender@example.com>' },
        { name: "Reply-To", value: "replies@example.com" },
        { name: "To", value: "me@example.com, teammate@example.com" },
        { name: "Cc", value: "Teammate <TEAMMATE@example.com>, observer@example.com" },
      );
      return response(value);
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch); const original = await adapter.getMessage(context, "m1");
    expect(original.from[0]).toEqual({ name: "Sender, Primary", address: "sender@example.com" });
    await adapter.reply(context, original, { text: "reply", replyAll: true, cc: ["extra@example.com"] });
    const payload = JSON.parse(sentBodies[0] ?? "{}") as { raw: string }; const mime = Buffer.from(payload.raw, "base64url").toString();
    expect(mime).toContain("To: replies@example.com");
    expect(mime).toContain("Cc: teammate@example.com, observer@example.com, extra@example.com");
    expect(mime).not.toContain("Cc: me@example.com");
  });

  it("does not reply to self when replying-all from a sent message", async () => {
    const sentBodies: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/messages/send")) { sentBodies.push(String(init?.body)); return response({ id: "reply", threadId: "t1" }); }
      const value = message("m1", "t1", []);
      value.payload.headers = [
        { name: "Subject", value: "Sent" }, { name: "From", value: "me@example.com" },
        { name: "To", value: "first@example.com, second@example.com" }, { name: "Message-ID", value: "<sent@example.com>" },
      ];
      return response(value);
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    await adapter.reply(context, await adapter.getMessage(context, "m1"), { text: "follow up", replyAll: true, bcc: ["ME@example.com", "hidden@example.com"] });
    const payload = JSON.parse(sentBodies[0] ?? "{}") as { raw: string };
    const mime = Buffer.from(payload.raw, "base64url").toString();
    expect(mime).toContain("To: first@example.com");
    expect(mime).toContain("Cc: second@example.com");
    expect(mime).toContain("Bcc: hidden@example.com");
    expect(mime.toLowerCase()).not.toContain("me@example.com");
  });

  it("forwards the bounded original RFC 822 message and preserves caller attachments", async () => {
    const originalRaw = "From: sender@example.com\r\nSubject: Original\r\n\r\nOriginal body";
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.includes("format=raw")) return response({ id: "m1", threadId: "t1", raw: Buffer.from(originalRaw).toString("base64url") });
      if (url.endsWith("/messages/send")) return response({ id: "forwarded" });
      return response(message("m1", "t1", []));
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    const original = await adapter.getMessage(context, "m1");
    await adapter.forward(context, original, {
      to: ["recipient@example.com"], subject: "", text: "FYI",
      attachments: [{ filename: "note.txt", contentType: "text/plain", contentBase64: Buffer.from("note").toString("base64") }],
    });
    const sent = JSON.parse(calls.find((call) => call.url.endsWith("/messages/send"))?.body ?? "{}") as { raw: string };
    const mime = Buffer.from(sent.raw, "base64url").toString();
    expect(mime).toContain("Subject: Fwd: Hello");
    expect(mime).toContain('filename="note.txt"');
    expect(mime).toContain('filename="forwarded-message.eml"');
    expect(mime).toContain(Buffer.from(originalRaw).toString("base64"));
  });

  it("rejects an oversized raw forward before composing or sending", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("format=raw")) return response({ id: "m1", raw: "YQ==", sizeEstimate: 10 * 1024 * 1024 + 1 });
      return response(message("m1", "t1", []));
    });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    await expect(adapter.forward(context, await adapter.getMessage(context, "m1"), { to: ["recipient@example.com"], subject: "", text: "FYI" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/messages/send"))).toHaveLength(0);
  });

  it("maps archive, trash, unread and starred to Gmail-native operations", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), ...(typeof init?.body === "string" ? { body: init.body } : {}) }); return response({ id: "m1" }); });
    const adapter = await adapterWithToken(fetchMock as typeof fetch);
    await adapter.archive(context, ["m1"]); await adapter.trash(context, ["m1"]); await adapter.setFlags(context, ["m1"], { read: false, starred: true });
    expect(calls.some((call) => call.url.endsWith("/messages/m1/trash"))).toBe(true);
    expect(calls.map((call) => call.body).join(" ")).toContain('"removeLabelIds":["INBOX"]');
    expect(calls.map((call) => call.body).join(" ")).toContain('"addLabelIds":["UNREAD","STARRED"]');
  });
});

async function adapterWithToken(fetchImpl: typeof fetch): Promise<GmailProvider> {
  return new GmailProvider(await tokensWithFetch(fetchImpl), fetchImpl);
}
async function tokensWithFetch(fetchImpl: typeof fetch): Promise<GoogleTokenBroker> {
  const store = new InMemoryGmailCredentialStore();
  await store.put("gmail:gmail-personal", { refreshToken: "refresh", accessToken: "access", expiresAt: Date.now() + 3_600_000, grantedScopes: [] });
  return new GoogleTokenBroker({ clientId: "client" }, store, fetchImpl);
}
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function message(id: string, threadId: string, labelIds: string[]) { return { id, threadId, labelIds, snippet: "preview", internalDate: "1787356800000", payload: { headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "Sender <sender@example.com>" }, { name: "To", value: "me@example.com" }, { name: "Message-ID", value: `<${id}@example.com>` }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64url") } }, { mimeType: "text/plain", filename: "note.txt", body: { attachmentId: "a1", size: 4 } }] } }; }
