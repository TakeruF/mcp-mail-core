import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountRegistry, createMailHost, type MailCapabilities, type MailProviderAdapter, type RegisteredAccount } from "../src/index.js";

const capabilities: MailCapabilities = {
  search: true, nativeSearch: false, threads: false, labels: false, folders: false, attachments: false,
  drafts: false, send: true, reply: false, forward: false, archive: false, trash: false, permanentDelete: false, flags: [],
};

function adapter(id: string, failing = false): MailProviderAdapter {
  return {
    id, capabilities,
    health: vi.fn(async () => ({ status: "ready" as const, identity: `${id}@example.com` })),
    search: vi.fn(async () => {
      if (failing) throw new Error("provider-private failure");
      return { messages: [{ providerMessageId: "same-id", subject: id, from: [], to: [], unread: false, starred: false, snippet: "", hasAttachments: false }] };
    }),
    getMessage: vi.fn(),
    send: vi.fn(async () => ({ providerMessageId: `sent-by-${id}` })),
  };
}

function account(id: string, provider: string): RegisteredAccount {
  return { id, provider, label: id, roles: [], capabilities, status: "ready", credentialId: `credential:${id}` };
}

describe("provider-neutral mail host", () => {
  it("composes independently configured providers with provenance and isolated writes", async () => {
    const alpha = adapter("alpha");
    const beta = adapter("beta");
    const host = createMailHost({
      registry: new InMemoryAccountRegistry([account("alpha-main", "alpha"), account("beta-main", "beta")]),
      providers: [alpha, beta],
      cursorSecret: new Uint8Array(32).fill(17),
    });
    const search = await host.service.search({ accounts: "*", query: {} });
    expect(search.pages.map((page) => page.messages[0]?.ref)).toEqual([
      { accountId: "alpha-main", messageId: "same-id" },
      { accountId: "beta-main", messageId: "same-id" },
    ]);
    await expect(host.service.send({ accountId: "beta-main", message: { to: ["to@example.com"], subject: "x", text: "x" }, confirm: true })).resolves.toEqual({ providerMessageId: "sent-by-beta" });
    expect(alpha.send).not.toHaveBeenCalled();
    expect(beta.send).toHaveBeenCalledOnce();
    expect(host.server).toBeDefined();
  });

  it("keeps a provider failure visible without dropping another provider page", async () => {
    const host = createMailHost({
      registry: new InMemoryAccountRegistry([account("working-main", "working"), account("broken-main", "broken")]),
      providers: [adapter("working"), adapter("broken", true)],
      cursorSecret: new Uint8Array(32).fill(18),
    });
    const search = await host.service.search({ accounts: "*", query: {} });
    expect(search.pages).toHaveLength(1);
    expect(search.pages[0]?.accountId).toBe("working-main");
    expect(search.failures).toEqual([{ accountId: "broken-main", code: "INTERNAL", message: "The mail operation failed.", retryable: false }]);
  });
});
