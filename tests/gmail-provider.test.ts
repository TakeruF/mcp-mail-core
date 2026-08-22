import { describe, expect, it, vi } from "vitest";
import { GmailProvider, GoogleTokenBroker, InMemoryGmailCredentialStore, gmailQuery, type ProviderContext } from "../src/index.js";

const context: ProviderContext = { account: { id: "gmail-personal", provider: "gmail", label: "Personal", roles: ["personal"], status: "ready", capabilities: { search: true, nativeSearch: true, threads: "native", labels: true, folders: false, attachments: true, drafts: true, send: true, reply: true, forward: true, archive: true, trash: true, permanentDelete: false, flags: ["read", "starred"] } }, credentialId: "gmail:gmail-personal" };

describe("Gmail provider", () => {
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
    expect(await adapter.updateDraft(context, "d1", { to: ["a@example.com"], subject: "Draft 2", text: "body" })).toMatchObject({ providerMessageId: "draft-message-2" });
    expect(await adapter.sendDraft(context, "d1")).toMatchObject({ providerMessageId: "sent-draft" });
    const original = await adapter.getMessage(context, "m1");
    await adapter.reply(context, original, { text: "reply" });
    const replyBody = JSON.parse(calls.find((call) => call.url.endsWith("/messages/send"))?.body ?? "{}") as { raw: string; threadId: string };
    expect(replyBody.threadId).toBe("t1");
    expect(Buffer.from(replyBody.raw, "base64url").toString()).toContain("In-Reply-To: <m1@example.com>");
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
  const store = new InMemoryGmailCredentialStore();
  await store.put("gmail:gmail-personal", { refreshToken: "refresh", accessToken: "access", expiresAt: Date.now() + 3_600_000, grantedScopes: [] });
  return new GmailProvider(new GoogleTokenBroker({ clientId: "client" }, store, fetchImpl), fetchImpl);
}
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function message(id: string, threadId: string, labelIds: string[]) { return { id, threadId, labelIds, snippet: "preview", internalDate: "1787356800000", payload: { headers: [{ name: "Subject", value: "Hello" }, { name: "From", value: "Sender <sender@example.com>" }, { name: "To", value: "me@example.com" }, { name: "Message-ID", value: `<${id}@example.com>` }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64url") } }, { mimeType: "text/plain", filename: "note.txt", body: { attachmentId: "a1", size: 4 } }] } }; }
