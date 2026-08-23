import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountRegistry, InMemoryGmailCredentialStore, MailError, MultiAccountMailService, type MailProviderAdapter, type ProviderContext, type ProviderMessage, type RegisteredAccount } from "../src/index.js";

const capabilities = { search: true as const, nativeSearch: false, threads: false as const, labels: false, folders: true, attachments: false, drafts: false, send: true, reply: false, forward: false, archive: true, trash: true, permanentDelete: false, flags: ["read"] as const };
const cursorSecret = Buffer.alloc(32, 7);
const account = (id: string, credentialId = `credential:${id}`): RegisteredAccount => ({ id, provider: "mock", label: id, roles: [], capabilities, status: "ready", credentialId });

function provider(overrides: Partial<MailProviderAdapter> = {}): MailProviderAdapter {
  return {
    id: "mock", capabilities,
    health: vi.fn(async () => ({ status: "ready" as const })),
    search: vi.fn(async (_context, _query, cursor) => ({ messages: [{ providerMessageId: cursor ? "next" : "same-id", subject: "Hello", from: [], to: [], unread: false, starred: false, snippet: "summary", hasAttachments: false }], ...(cursor ? {} : { nextCursor: "page-2" }) })),
    getMessage: vi.fn(async (_context, id) => detail(id)),
    send: vi.fn(async () => ({ providerMessageId: "sent" })),
    archive: vi.fn(async () => undefined), trash: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("multi-account core", () => {
  it("keeps account and credential identities separate and rejects overwrites", async () => {
    const registry = new InMemoryAccountRegistry([account("gmail-personal"), account("gmail-university")]);
    const credentials = new InMemoryGmailCredentialStore();
    await credentials.put("gmail:gmail-personal", { refreshToken: "one", grantedScopes: [] });
    await credentials.put("gmail:gmail-university", { refreshToken: "two", grantedScopes: [] });
    await expect(credentials.put("gmail:gmail-personal", { refreshToken: "overwrite", grantedScopes: [] })).rejects.toThrow("already exist");
    expect((await registry.list()).map((item) => item.id)).toEqual(["gmail-personal", "gmail-university"]);
    expect((await credentials.get("gmail:gmail-personal"))?.refreshToken).toBe("one");
  });

  it("searches selected or all accounts, qualifies colliding IDs, and paginates per account", async () => {
    const adapter = provider();
    const service = new MultiAccountMailService(new InMemoryAccountRegistry([account("personal"), account("university")]), [adapter], cursorSecret);
    const first = await service.search({ accounts: "*", query: { text: "OpenAI" }, limitPerAccount: 2 });
    expect(first.pages.map((page) => page.accountId)).toEqual(["personal", "university"]);
    expect(first.pages.map((page) => page.messages[0]?.ref)).toEqual([{ accountId: "personal", messageId: "same-id" }, { accountId: "university", messageId: "same-id" }]);
    expect(first.nextCursor).toBeTruthy();
    const second = await service.search({ accounts: ["university"], query: { text: "OpenAI" }, limitPerAccount: 2 });
    expect(second.pages).toHaveLength(1);
    const continued = await service.search({ accounts: "*", query: { text: "OpenAI" }, limitPerAccount: 2, cursor: first.nextCursor! });
    expect(continued.pages.flatMap((page) => page.messages).map((message) => message.ref.messageId)).toEqual(["next", "next"]);
  });

  it("returns partial failures without discarding successful account results", async () => {
    const adapter = provider({ search: vi.fn(async (context: ProviderContext) => {
      if (context.account.id === "broken") throw new MailError("PROVIDER_UNAVAILABLE", "Temporary failure.", true);
      return { messages: [{ providerMessageId: "ok", subject: "ok", from: [], to: [], unread: false, starred: false, snippet: "", hasAttachments: false }] };
    }) });
    const service = new MultiAccountMailService(new InMemoryAccountRegistry([account("working"), account("broken")]), [adapter], cursorSecret);
    const result = await service.search({ query: {}, accounts: "*" });
    expect(result.pages[0]?.messages[0]?.ref.accountId).toBe("working");
    expect(result.failures).toEqual([{ accountId: "broken", code: "PROVIDER_UNAVAILABLE", message: "Temporary failure.", retryable: true }]);
  });

  it("requires explicit source account and same-call confirmation for writes", async () => {
    const adapter = provider(); const service = new MultiAccountMailService(new InMemoryAccountRegistry([account("personal")]), [adapter], cursorSecret);
    await expect(service.send({ accountId: "personal", message: { to: ["a@example.com"], subject: "x", text: "x" } } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.send({ accountId: "missing", message: { to: ["a@example.com"], subject: "x", text: "x" }, confirm: true })).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await service.send({ accountId: "personal", message: { to: ["a@example.com"], subject: "x", text: "x" }, confirm: true });
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it("preserves explicit draft cleanup outcomes so callers never infer a resend", async () => {
    const draftCapabilities = { ...capabilities, drafts: true };
    const adapter = provider({
      capabilities: draftCapabilities,
      updateDraft: vi.fn(async () => ({
        providerDraftId: "replacement", providerMessageId: "replacement-message",
        previousDraftDisposition: "retained" as const,
        warning: "The replacement exists, but the previous draft remains.",
      })),
      sendDraft: vi.fn(async () => ({
        providerMessageId: "sent",
        draftDisposition: "retained" as const,
        warning: "The message was sent. Do not resend; remove the retained draft manually.",
      })),
    });
    const draftAccount: RegisteredAccount = { ...account("personal"), capabilities: draftCapabilities };
    const service = new MultiAccountMailService(new InMemoryAccountRegistry([draftAccount]), [adapter], cursorSecret);
    await expect(service.updateDraft({
      ref: { accountId: "personal", draftId: "old" },
      message: { to: ["a@example.com"], subject: "replacement", text: "body" },
      confirm: true,
    })).resolves.toMatchObject({ previousDraftDisposition: "retained", warning: expect.stringContaining("previous draft") });
    await expect(service.sendDraft({ ref: { accountId: "personal", draftId: "replacement" }, confirm: true })).resolves.toMatchObject({
      providerMessageId: "sent", draftDisposition: "retained", warning: expect.stringContaining("Do not resend"),
    });
  });

  it("rejects cross-account bulk mutations instead of partially applying them", async () => {
    const adapter = provider();
    const service = new MultiAccountMailService(new InMemoryAccountRegistry([account("personal"), account("work")]), [adapter], cursorSecret);
    await expect(service.trash({ refs: [{ accountId: "personal", messageId: "one" }, { accountId: "work", messageId: "two" }], confirm: true })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(service.archive({ refs: [{ accountId: "personal", messageId: "one" }, { accountId: "work", messageId: "two" }], confirm: true })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(service.setFlags({ refs: [{ accountId: "personal", messageId: "one" }, { accountId: "work", messageId: "two" }], changes: { read: true }, confirm: true })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    expect(adapter.trash).not.toHaveBeenCalled();
    expect(adapter.archive).not.toHaveBeenCalled();
    expect(adapter.setFlags).toBeUndefined();
  });

  it("fails closed for unsupported capabilities and exposes no permanent-delete operation", async () => {
    const service = new MultiAccountMailService(new InMemoryAccountRegistry([account("personal")]), [provider()], cursorSecret);
    await expect(service.getThread({ accountId: "personal", threadId: "t" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect("permanentDelete" in service).toBe(false);
  });

  it("refreshes safe account health metadata without exposing credential handles", async () => {
    const adapter = provider({ health: vi.fn(async (context: ProviderContext) => context.account.id === "personal" ? { status: "ready" as const, identity: "me@example.com" } : { status: "reauthorization_required" as const }) });
    const registry = new InMemoryAccountRegistry([account("personal"), account("university")]);
    const service = new MultiAccountMailService(registry, [adapter], cursorSecret);
    const result = await service.refreshAccountHealth();
    expect(result).toEqual([
      expect.objectContaining({ id: "personal", status: "ready", providerIdentity: "me@example.com" }),
      expect.objectContaining({ id: "university", status: "reauthorization_required" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("credential:");
    expect((await registry.get("university"))?.status).toBe("reauthorization_required");
  });
});

function detail(id: string): ProviderMessage {
  return { providerMessageId: id, subject: "Subject", from: [{ address: "sender@example.com" }], to: [], cc: [], replyTo: [], unread: false, starred: false, snippet: "", hasAttachments: false, bodyText: "body", bodyTruncated: false, attachments: [], references: [] };
}
