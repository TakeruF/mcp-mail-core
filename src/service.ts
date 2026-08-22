import { publicAccount, type AccountRegistry } from "./account-registry.js";
import { decodeCrossAccountCursor, encodeCrossAccountCursor, queryFingerprint } from "./cursor.js";
import type {
  AccountFailure, AccountSearchPage, AttachmentRef, Confirmed, CrossAccountSearchPage, DraftRef, MailAccount,
  MessageDetail, MessageRef, OutgoingMessage, RegisteredAccount, SearchQuery, ThreadRef,
} from "./domain.js";
import { MailError, publicFailure } from "./errors.js";
import type { MailProviderAdapter, ProviderContext, ProviderMessage, SendResult } from "./provider.js";

export class MultiAccountMailService {
  readonly #providers = new Map<string, MailProviderAdapter>();
  public constructor(private readonly registry: AccountRegistry, providers: readonly MailProviderAdapter[]) {
    for (const provider of providers) {
      if (this.#providers.has(provider.id)) throw new MailError("INVALID_INPUT", `Duplicate provider '${provider.id}'.`);
      this.#providers.set(provider.id, provider);
    }
  }

  public async listAccounts(): Promise<readonly MailAccount[]> {
    return (await this.registry.list()).map(publicAccount);
  }

  /** Reads default to all ready accounts. Writes never have an account default. */
  public async search(input: { query: SearchQuery; accounts?: readonly string[] | "*"; cursor?: string; limitPerAccount?: number }): Promise<CrossAccountSearchPage> {
    const selected = await this.selectReadAccounts(input.accounts ?? "*");
    const limit = input.limitPerAccount ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MailError("INVALID_INPUT", "limitPerAccount must be between 1 and 100.");
    const ids = selected.map((account) => account.id).sort();
    const fingerprint = queryFingerprint(ids, input.query, limit);
    const cursor = input.cursor ? decodeCrossAccountCursor(input.cursor, fingerprint) : undefined;
    const work = selected.filter((account) => cursor?.cursors[account.id] !== null);
    const settled = await Promise.all(work.map(async (account): Promise<AccountSearchPage | AccountFailure> => {
      try {
        const { provider, context } = this.resolveAccount(account);
        const storedCursor = cursor?.cursors[account.id];
        const page = await provider.search(context, input.query, storedCursor ? storedCursor : undefined, limit);
        return {
          accountId: account.id,
          messages: page.messages.map((message) => ({
            ...message,
            ref: { accountId: account.id, messageId: message.providerMessageId },
            ...(message.providerThreadId ? { threadRef: { accountId: account.id, threadId: message.providerThreadId } } : {}),
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      } catch (error) {
        return { accountId: account.id, ...publicFailure(error) };
      }
    }));
    const pages = settled.filter((item): item is AccountSearchPage => "messages" in item);
    const failures = settled.filter((item): item is AccountFailure => "code" in item);
    const nextCursors: Record<string, string | null> = { ...(cursor?.cursors ?? {}) };
    for (const account of selected) if (!(account.id in nextCursors)) nextCursors[account.id] = null;
    for (const page of pages) nextCursors[page.accountId] = page.nextCursor ?? null;
    // A failed account retains its previous cursor, so retrying the page cannot silently skip it.
    for (const failure of failures) nextCursors[failure.accountId] = cursor?.cursors[failure.accountId] ?? "";
    const hasNext = Object.values(nextCursors).some((value) => value !== null);
    return {
      pages,
      failures,
      ...(hasNext ? { nextCursor: encodeCrossAccountCursor({ v: 1, fingerprint, cursors: nextCursors }) } : {}),
    };
  }

  public async getMessage(ref: MessageRef): Promise<MessageDetail> {
    const { provider, context } = await this.resolve(ref.accountId);
    return this.qualifyMessage(ref.accountId, await provider.getMessage(context, ref.messageId));
  }

  public async getThread(ref: ThreadRef): Promise<{ messages: readonly MessageDetail[] }> {
    const { provider, context } = await this.resolve(ref.accountId);
    if (!provider.getThread) throw new MailError("CAPABILITY_UNSUPPORTED", `Account '${ref.accountId}' does not support threads.`);
    const result = await provider.getThread(context, ref.threadId);
    return { messages: result.messages.map((message) => this.qualifyMessage(ref.accountId, message)) };
  }

  public async getAttachment(ref: AttachmentRef) {
    const { provider, context } = await this.resolve(ref.accountId);
    if (!provider.getAttachment) throw new MailError("CAPABILITY_UNSUPPORTED", `Account '${ref.accountId}' does not support attachments.`);
    return provider.getAttachment(context, ref.messageId, ref.attachmentId);
  }

  public async send(input: Confirmed<{ accountId: string; message: OutgoingMessage }>): Promise<SendResult> {
    this.assertConfirmed(input);
    const { provider, context } = await this.resolveWrite(input.accountId, "send");
    if (!provider.send) throw new MailError("CAPABILITY_UNSUPPORTED", "Sending is unsupported.");
    return provider.send(context, input.message);
  }

  public async createDraft(input: Confirmed<{ accountId: string; message: OutgoingMessage; replyTo?: MessageRef }>) {
    this.assertConfirmed(input);
    const { provider, context } = await this.resolveWrite(input.accountId, "drafts");
    if (!provider.createDraft) throw new MailError("CAPABILITY_UNSUPPORTED", "Drafts are unsupported.");
    const original = input.replyTo ? await this.sameAccountMessage(input.accountId, input.replyTo) : undefined;
    return provider.createDraft(context, input.message, original);
  }


  public async updateDraft(input: Confirmed<{ ref: DraftRef; message: OutgoingMessage }>) {
    this.assertConfirmed(input);
    const { provider, context } = await this.resolveWrite(input.ref.accountId, "drafts");
    if (!provider.updateDraft) throw new MailError("CAPABILITY_UNSUPPORTED", "Draft updates are unsupported.");
    return provider.updateDraft(context, input.ref.draftId, input.message);
  }

  public async sendDraft(input: Confirmed<{ ref: DraftRef }>) {
    this.assertConfirmed(input);
    const { provider, context } = await this.resolveWrite(input.ref.accountId, "drafts");
    if (!provider.sendDraft) throw new MailError("CAPABILITY_UNSUPPORTED", "Sending drafts is unsupported.");
    return provider.sendDraft(context, input.ref.draftId);
  }

  public async reply(input: Confirmed<{ ref: MessageRef; message: Omit<OutgoingMessage, "subject" | "to"> }>) {
    this.assertConfirmed(input);
    const { provider, context } = await this.resolveWrite(input.ref.accountId, "reply");
    if (!provider.reply) throw new MailError("CAPABILITY_UNSUPPORTED", "Reply is unsupported.");
    return provider.reply(context, await provider.getMessage(context, input.ref.messageId), input.message);
  }


  public async forward(input: Confirmed<{ ref: MessageRef; message: OutgoingMessage }>) {
    this.assertConfirmed(input);
    const { provider, context } = await this.resolveWrite(input.ref.accountId, "forward");
    if (!provider.forward) throw new MailError("CAPABILITY_UNSUPPORTED", "Forwarding is unsupported.");
    return provider.forward(context, await provider.getMessage(context, input.ref.messageId), input.message);
  }

  public async archive(input: Confirmed<{ refs: readonly MessageRef[] }>): Promise<void> { this.assertConfirmed(input); return this.mutateRefs(input.refs, "archive"); }
  public async trash(input: Confirmed<{ refs: readonly MessageRef[] }>): Promise<void> { this.assertConfirmed(input); return this.mutateRefs(input.refs, "trash"); }
  public async setFlags(input: Confirmed<{ refs: readonly MessageRef[]; changes: { read?: boolean; starred?: boolean; answered?: boolean } }>): Promise<void> {
    this.assertConfirmed(input);
    const grouped = this.groupRefs(input.refs);
    for (const [accountId, refs] of grouped) {
      const { provider, context } = await this.resolveWrite(accountId, "flags");
      if (!provider.setFlags) throw new MailError("CAPABILITY_UNSUPPORTED", `Account '${accountId}' does not support flags.`);
      await provider.setFlags(context, refs.map((ref) => ref.messageId), input.changes);
    }
  }

  private async mutateRefs(refs: readonly MessageRef[], operation: "archive" | "trash"): Promise<void> {
    for (const [accountId, accountRefs] of this.groupRefs(refs)) {
      const { provider, context } = await this.resolveWrite(accountId, operation);
      const fn = provider[operation];
      if (!fn) throw new MailError("CAPABILITY_UNSUPPORTED", `Account '${accountId}' does not support ${operation}.`);
      await fn.call(provider, context, accountRefs.map((ref) => ref.messageId));
    }
  }

  private groupRefs(refs: readonly MessageRef[]): Map<string, MessageRef[]> {
    if (refs.length < 1 || refs.length > 100) throw new MailError("INVALID_INPUT", "Mutations require 1 to 100 explicit message references.");
    const result = new Map<string, MessageRef[]>();
    for (const ref of refs) result.set(ref.accountId, [...(result.get(ref.accountId) ?? []), ref]);
    return result;
  }

  private async resolve(accountId: string): Promise<{ provider: MailProviderAdapter; context: ProviderContext }> {
    const account = await this.registry.get(accountId);
    if (!account) throw new MailError("ACCOUNT_NOT_FOUND", `Account '${accountId}' was not found.`);
    return this.resolveAccount(account);
  }

  private resolveAccount(account: RegisteredAccount): { provider: MailProviderAdapter; context: ProviderContext } {
    const provider = this.#providers.get(account.provider);
    if (!provider) throw new MailError("CAPABILITY_UNSUPPORTED", `Provider '${account.provider}' is not installed.`);
    return { provider, context: { account: publicAccount(account), credentialId: account.credentialId } };
  }

  private async selectReadAccounts(selection: readonly string[] | "*") {
    const all = await this.registry.list();
    if (selection === "*") return all.filter((account) => account.status === "ready");
    if (selection.length === 0) throw new MailError("INVALID_INPUT", "At least one account is required.");
    const unique = [...new Set(selection)];
    return Promise.all(unique.map(async (id) => {
      const account = await this.registry.get(id);
      if (!account) throw new MailError("ACCOUNT_NOT_FOUND", `Account '${id}' was not found.`);
      if (account.status !== "ready") throw new MailError("ACCOUNT_NOT_READY", `Account '${id}' is not ready.`);
      return account;
    }));
  }

  private async resolveWrite(accountId: string, capability: keyof MailAccount["capabilities"]): Promise<{ provider: MailProviderAdapter; context: ProviderContext }> {
    const resolved = await this.resolve(accountId);
    if (resolved.context.account.status !== "ready") throw new MailError("ACCOUNT_NOT_READY", `Account '${accountId}' is not ready.`);
    if (!resolved.context.account.capabilities[capability]) throw new MailError("CAPABILITY_UNSUPPORTED", `Account '${accountId}' does not support ${capability}.`);
    return resolved;
  }

  private async sameAccountMessage(accountId: string, ref: MessageRef): Promise<ProviderMessage> {
    if (accountId !== ref.accountId) throw new MailError("INVALID_REFERENCE", "A draft reply source must belong to the sending account.");
    const { provider, context } = await this.resolve(accountId);
    return provider.getMessage(context, ref.messageId);
  }

  private qualifyMessage(accountId: string, message: ProviderMessage): MessageDetail {
    return {
      ...message,
      ref: { accountId, messageId: message.providerMessageId },
      ...(message.providerThreadId ? { threadRef: { accountId, threadId: message.providerThreadId } } : {}),
      attachments: message.attachments.map((attachment) => ({ ...attachment, ref: { accountId, messageId: message.providerMessageId, attachmentId: attachment.attachmentId } })),
    };
  }

  private assertConfirmed(input: { confirm?: unknown }): asserts input is { confirm: true } {
    if (input.confirm !== true) throw new MailError("INVALID_INPUT", "This mutation requires confirm=true in the same call.");
  }
}
