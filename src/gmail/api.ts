import { MailError } from "../errors.js";
import type { GoogleTokenBroker } from "./oauth.js";

export type GmailHeader = { name?: string; value?: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
};
export type GmailMessage = { id: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; sizeEstimate?: number; payload?: GmailPart; raw?: string };
export type GmailDraft = { id: string; message: GmailMessage };
export type GmailApiBounds = Readonly<{ requestTimeoutMs?: number; maxResponseBytes?: number }>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

export class GmailApi {
  public constructor(
    private readonly credentialId: string,
    private readonly tokens: GoogleTokenBroker,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly random: () => number = Math.random,
    private readonly bounds: GmailApiBounds = {},
  ) {}

  public profile(accessToken?: string): Promise<{ emailAddress: string }> {
    return this.request("/users/me/profile", {}, accessToken);
  }
  public listMessages(params: { q?: string; pageToken?: string; maxResults: number }): Promise<{ messages?: { id: string; threadId?: string }[]; nextPageToken?: string }> {
    const query = new URLSearchParams({ maxResults: String(params.maxResults), ...(params.q ? { q: params.q } : {}), ...(params.pageToken ? { pageToken: params.pageToken } : {}) });
    return this.request(`/users/me/messages?${query.toString()}`);
  }
  public getMessage(id: string, format: "metadata" | "full" | "raw" = "full"): Promise<GmailMessage> {
    // A fields-projected full response preserves MIME part/attachment metadata
    // without returning body.data. Gmail's metadata format omits part structure.
    const query = format === "metadata"
      ? new URLSearchParams({ format: "full", fields: "id,threadId,labelIds,snippet,internalDate,payload(headers,parts(partId,mimeType,filename,body(attachmentId,size),parts))" })
      : new URLSearchParams({ format });
    return this.request(`/users/me/messages/${encodeURIComponent(id)}?${query.toString()}`);
  }
  public getThread(id: string): Promise<{ messages?: GmailMessage[] }> { return this.request(`/users/me/threads/${encodeURIComponent(id)}?format=full`); }
  public getAttachment(messageId: string, attachmentId: string): Promise<{ data?: string; size?: number }> { return this.request(`/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`); }
  public createDraft(raw: string, threadId?: string): Promise<GmailDraft> { return this.request("/users/me/drafts", { method: "POST", body: json({ message: { raw, ...(threadId ? { threadId } : {}) } }) }); }
  public updateDraft(id: string, raw: string): Promise<GmailDraft> { return this.request(`/users/me/drafts/${encodeURIComponent(id)}`, { method: "PUT", body: json({ message: { raw } }) }); }
  public sendDraft(id: string): Promise<GmailMessage> { return this.request("/users/me/drafts/send", { method: "POST", body: json({ id }) }); }
  public sendMessage(raw: string, threadId?: string): Promise<GmailMessage> { return this.request("/users/me/messages/send", { method: "POST", body: json({ raw, ...(threadId ? { threadId } : {}) }) }); }
  public trash(id: string): Promise<GmailMessage> { return this.request(`/users/me/messages/${encodeURIComponent(id)}/trash`, { method: "POST", body: json({}) }); }
  public modify(id: string, addLabelIds: readonly string[], removeLabelIds: readonly string[]): Promise<GmailMessage> { return this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: json({ addLabelIds, removeLabelIds }) }); }

  private async request<T>(path: string, init: RequestInit = {}, tokenOverride?: string): Promise<T> {
    const token = tokenOverride ?? await this.tokens.accessToken(this.credentialId);
    const method = (init.method ?? "GET").toUpperCase();
    const attempts = method === "GET" ? 3 : 1;
    let response: Response | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        response = await this.fetchImpl(`https://gmail.googleapis.com/gmail/v1${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.bounds.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
          headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        });
      } catch {
        throw new MailError("PROVIDER_UNAVAILABLE", "Gmail did not respond within the configured network boundary.", true);
      }
      if (response.ok || !isRetryableStatus(response.status) || attempt === attempts - 1) break;
      try { await response.body?.cancel(); } catch { /* best effort before retry */ }
      await this.sleep(retryDelay(response.headers.get("retry-after"), attempt, this.random));
    }
    if (!response) throw new MailError("PROVIDER_UNAVAILABLE", "Gmail did not return a response.", true);
    if (!response.ok) {
      let reason = "";
      try { reason = JSON.stringify(await readJsonBounded(response, 64 * 1024)); } catch { /* redacted below */ }
      if (response.status === 401) throw new MailError("REAUTHORIZATION_REQUIRED", "Gmail authorization is invalid.");
      if (response.status === 404) throw new MailError("MESSAGE_NOT_FOUND", "The Gmail message was not found.");
      if (response.status === 429) throw new MailError("RATE_LIMITED", "Gmail rate limit was reached.", true);
      if (response.status >= 500) throw new MailError("PROVIDER_UNAVAILABLE", "Gmail is temporarily unavailable.", true);
      throw new MailError("INVALID_INPUT", `Gmail rejected the request (${response.status}${reason.includes("invalidArgument") ? ": invalid argument" : ""}).`);
    }
    if (response.status === 204) return undefined as T;
    return await readJsonBounded(response, this.bounds.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) as T;
  }
}

async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw responseTooLarge();
  if (!response.body) throw new MailError("PROVIDER_UNAVAILABLE", "Gmail returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw responseTooLarge();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new MailError("PROVIDER_UNAVAILABLE", "Gmail returned an invalid response."); }
}

function responseTooLarge(): MailError {
  return new MailError("PROVIDER_UNAVAILABLE", "Gmail returned a response larger than the configured safety bound.");
}

function json(value: unknown): string { return JSON.stringify(value); }
function isRetryableStatus(status: number): boolean { return status === 429 || status >= 500; }
function retryDelay(retryAfter: string | null, attempt: number, random: () => number): number {
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) return Math.min(retryAfterSeconds * 1000, 5_000);
  return Math.min(250 * 2 ** attempt + Math.floor(random() * 100), 2_000);
}
