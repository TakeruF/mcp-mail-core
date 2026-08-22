import type { MailCapabilities, OutgoingMessage, ProviderMessageSummary, ProviderSearchPage, SearchQuery } from "../domain.js";
import { MailError } from "../errors.js";
import type { DraftResult, MailProviderAdapter, ProviderContext, ProviderMessage, ProviderThread, SendResult } from "../provider.js";
import { GmailApi, type GmailHeader, type GmailMessage, type GmailPart } from "./api.js";
import { base64UrlMime, composeMime } from "./mime.js";
import type { GoogleTokenBroker } from "./oauth.js";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const GMAIL_CAPABILITIES: MailCapabilities = Object.freeze({
  search: true, nativeSearch: true, threads: "native", labels: true, folders: false,
  attachments: true, drafts: true, send: true, reply: true, forward: true,
  archive: true, trash: true, permanentDelete: false, flags: Object.freeze(["read", "starred"] as const),
});

export class GmailProvider implements MailProviderAdapter {
  public readonly id = "gmail";
  public readonly capabilities = GMAIL_CAPABILITIES;
  public constructor(private readonly tokens: GoogleTokenBroker, private readonly fetchImpl: typeof fetch = fetch) {}

  public async health(context: ProviderContext) {
    try { const profile = await this.api(context).profile(); return { status: "ready" as const, identity: profile.emailAddress }; }
    catch (error) { return { status: error instanceof MailError && error.code === "REAUTHORIZATION_REQUIRED" ? "reauthorization_required" as const : "error" as const }; }
  }

  public async search(context: ProviderContext, query: SearchQuery, cursor: string | undefined, limit: number): Promise<ProviderSearchPage> {
    const api = this.api(context);
    const listed = await api.listMessages({ q: gmailQuery(query), ...(cursor ? { pageToken: cursor } : {}), maxResults: limit });
    const messages = await mapConcurrent(listed.messages ?? [], 8, ({ id }) => api.getMessage(id, "metadata").then(toSummary));
    return { messages, ...(listed.nextPageToken ? { nextCursor: listed.nextPageToken } : {}) };
  }

  public async getMessage(context: ProviderContext, id: string): Promise<ProviderMessage> { return toMessage(await this.api(context).getMessage(id)); }
  public async getThread(context: ProviderContext, id: string): Promise<ProviderThread> { return { messages: (await this.api(context).getThread(id)).messages?.map(toMessage) ?? [] }; }
  public async getAttachment(context: ProviderContext, messageId: string, attachmentId: string) {
    const attachment = await this.api(context).getAttachment(messageId, attachmentId);
    const content = attachment.data ?? "";
    const size = attachment.size ?? Buffer.byteLength(content, "base64url");
    if (size > MAX_ATTACHMENT_BYTES) throw new MailError("INVALID_INPUT", `Attachments larger than ${MAX_ATTACHMENT_BYTES} bytes are not returned.`);
    return { contentType: "application/octet-stream", contentBase64: Buffer.from(content, "base64url").toString("base64"), size };
  }
  public async createDraft(context: ProviderContext, message: OutgoingMessage, replyTo?: ProviderMessage): Promise<DraftResult> {
    const created = await this.api(context).createDraft(base64UrlMime(composeMime(message, replyTo ? threadHeaders(replyTo) : undefined)), replyTo?.providerThreadId);
    return { providerDraftId: created.id, providerMessageId: created.message.id };
  }
  public async updateDraft(context: ProviderContext, draftId: string, message: OutgoingMessage): Promise<DraftResult> {
    const updated = await this.api(context).updateDraft(draftId, base64UrlMime(composeMime(message)));
    return { providerDraftId: updated.id, providerMessageId: updated.message.id };
  }
  public async sendDraft(context: ProviderContext, draftId: string): Promise<SendResult> { return sendResult(await this.api(context).sendDraft(draftId)); }
  public async send(context: ProviderContext, message: OutgoingMessage): Promise<SendResult> { return sendResult(await this.api(context).sendMessage(base64UrlMime(composeMime(message)))); }
  public async reply(context: ProviderContext, original: ProviderMessage, message: Omit<OutgoingMessage, "subject" | "to">): Promise<SendResult> {
    const reply: OutgoingMessage = { ...message, to: original.from.map((item) => item.address), subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}` };
    return sendResult(await this.api(context).sendMessage(base64UrlMime(composeMime(reply, threadHeaders(original))), original.providerThreadId));
  }
  public async forward(context: ProviderContext, original: ProviderMessage, message: OutgoingMessage): Promise<SendResult> {
    const raw = await this.api(context).getMessage(original.providerMessageId, "raw");
    if (!raw.raw) throw new MailError("PROVIDER_UNAVAILABLE", "Gmail did not return the original message for forwarding.");
    const forwarded: OutgoingMessage = {
      ...message,
      subject: message.subject || (/^fwd?:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`),
      attachments: [
        ...(message.attachments ?? []),
        {
          filename: "forwarded-message.eml",
          contentType: "message/rfc822",
          contentBase64: Buffer.from(raw.raw, "base64url").toString("base64"),
        },
      ],
    };
    return sendResult(await this.api(context).sendMessage(base64UrlMime(composeMime(forwarded))));
  }
  public async archive(context: ProviderContext, ids: readonly string[]): Promise<void> { for (const id of ids) await this.api(context).modify(id, [], ["INBOX"]); }
  public async trash(context: ProviderContext, ids: readonly string[]): Promise<void> { for (const id of ids) await this.api(context).trash(id); }
  public async setFlags(context: ProviderContext, ids: readonly string[], changes: { read?: boolean; starred?: boolean }): Promise<void> {
    const add: string[] = []; const remove: string[] = [];
    if (changes.read === true) remove.push("UNREAD"); else if (changes.read === false) add.push("UNREAD");
    if (changes.starred === true) add.push("STARRED"); else if (changes.starred === false) remove.push("STARRED");
    if (!add.length && !remove.length) throw new MailError("INVALID_INPUT", "At least one supported flag change is required.");
    for (const id of ids) await this.api(context).modify(id, add, remove);
  }

  private api(context: ProviderContext): GmailApi { return new GmailApi(context.credentialId, this.tokens, this.fetchImpl); }
}

export function gmailQuery(query: SearchQuery): string {
  const terms = [query.nativeQuery, query.text, query.from && `from:${quote(query.from)}`, query.to && `to:${quote(query.to)}`, query.subject && `subject:${quote(query.subject)}`, query.after && `after:${quote(query.after)}`, query.before && `before:${quote(query.before)}`, query.unread === true ? "is:unread" : query.unread === false ? "is:read" : undefined, query.hasAttachment === true ? "has:attachment" : undefined, query.folder && `in:${quote(query.folder)}`, ...(query.labels ?? []).map((label) => `label:${quote(label)}`)].filter((term): term is string => !!term);
  return terms.join(" ");
}

function toSummary(message: GmailMessage): ProviderMessageSummary {
  const headers = headerMap(message.payload?.headers);
  const labels = message.labelIds ?? [];
  const receivedAt = dateValue(message, headers);
  return {
    providerMessageId: message.id, ...(message.threadId ? { providerThreadId: message.threadId } : {}),
    subject: headers.get("subject") ?? "", from: parseAddresses(headers.get("from")), to: parseAddresses(headers.get("to")),
    ...(receivedAt ? { receivedAt } : {}), unread: labels.includes("UNREAD"), starred: labels.includes("STARRED"),
    snippet: message.snippet ?? "", hasAttachments: collectAttachments(message.payload).length > 0, labels,
  };
}

function toMessage(message: GmailMessage): ProviderMessage {
  const summary = toSummary(message); const headers = headerMap(message.payload?.headers);
  const body = collectText(message.payload).join("\n"); const limit = 20_000;
  const internetMessageId = headers.get("message-id");
  const inReplyTo = headers.get("in-reply-to");
  return { ...summary, cc: parseAddresses(headers.get("cc")), bodyText: body.length > limit ? `${body.slice(0, limit)}\n\n[truncated]` : body, bodyTruncated: body.length > limit,
    attachments: collectAttachments(message.payload), ...(internetMessageId ? { internetMessageId } : {}), ...(inReplyTo ? { inReplyTo } : {}), references: headers.get("references")?.split(/\s+/).filter(Boolean) ?? [] };
}

function collectAttachments(part: GmailPart | undefined): { attachmentId: string; filename?: string; contentType: string; size?: number }[] {
  if (!part) return []; const values: { attachmentId: string; filename?: string; contentType: string; size?: number }[] = [];
  if (part.body?.attachmentId) values.push({ attachmentId: part.body.attachmentId, ...(part.filename ? { filename: part.filename } : {}), contentType: part.mimeType ?? "application/octet-stream", ...(part.body.size !== undefined ? { size: part.body.size } : {}) });
  for (const child of part.parts ?? []) values.push(...collectAttachments(child)); return values;
}
function collectText(part: GmailPart | undefined): string[] {
  if (!part) return []; const values: string[] = [];
  if (part.mimeType === "text/plain" && part.body?.data) values.push(Buffer.from(part.body.data, "base64url").toString("utf8"));
  for (const child of part.parts ?? []) values.push(...collectText(child)); return values;
}
function headerMap(headers: GmailHeader[] | undefined): Map<string, string> { return new Map((headers ?? []).flatMap((item) => item.name && item.value ? [[item.name.toLowerCase(), item.value] as const] : [])); }
function parseAddresses(value: string | undefined) {
  if (!value) return [];
  return value.split(",").map((item) => {
    const match = /^(.*?)\s*<([^>]+)>$/.exec(item.trim());
    if (!match) return { address: item.trim() };
    const name = match[1]?.replace(/^"|"$/g, "").trim();
    return { ...(name ? { name } : {}), address: match[2]! };
  });
}
function dateValue(message: GmailMessage, headers: Map<string, string>): string | undefined { const value = message.internalDate ? Number(message.internalDate) : Date.parse(headers.get("date") ?? ""); return Number.isFinite(value) ? new Date(value).toISOString() : undefined; }
function threadHeaders(message: ProviderMessage) { return { ...(message.internetMessageId ? { messageId: message.internetMessageId } : {}), references: [...message.references, ...(message.internetMessageId ? [message.internetMessageId] : [])] }; }
function sendResult(message: GmailMessage): SendResult { return { providerMessageId: message.id, ...(message.threadId ? { providerThreadId: message.threadId } : {}) }; }
function quote(value: string): string { return /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value; }
async function mapConcurrent<T, U>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length); let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; output[index] = await operation(items[index]!); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}
