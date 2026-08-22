import type {
  MailAccount, MailCapabilities, MessageDetail, MessageSummary,
  OutgoingMessage, ProviderSearchPage, SearchQuery,
} from "./domain.js";

export type ProviderContext = Readonly<{ account: MailAccount; credentialId: string }>;
export type ProviderAttachment = Readonly<{ attachmentId: string; filename?: string; contentType: string; size?: number }>;
export type ProviderMessage = Omit<MessageDetail, "ref" | "threadRef" | "attachments"> & Readonly<{
  providerMessageId: string;
  providerThreadId?: string;
  attachments: readonly ProviderAttachment[];
}>;
export type ProviderThread = Readonly<{ messages: readonly ProviderMessage[] }>;
export type SendResult = Readonly<{ providerMessageId: string; providerThreadId?: string }>;
export type DraftResult = Readonly<{ providerDraftId: string; providerMessageId: string }>;

export interface MailProviderAdapter {
  readonly id: string;
  readonly capabilities: MailCapabilities;
  health(context: ProviderContext): Promise<{ status: "ready" | "reauthorization_required" | "error"; identity?: string }>;
  search(context: ProviderContext, query: SearchQuery, cursor: string | undefined, limit: number): Promise<ProviderSearchPage>;
  getMessage(context: ProviderContext, providerMessageId: string): Promise<ProviderMessage>;
  getThread?(context: ProviderContext, providerThreadId: string): Promise<ProviderThread>;
  getAttachment?(context: ProviderContext, providerMessageId: string, attachmentId: string): Promise<{ contentType: string; filename?: string; contentBase64: string; size: number }>;
  createDraft?(context: ProviderContext, message: OutgoingMessage, replyTo?: ProviderMessage): Promise<DraftResult>;
  updateDraft?(context: ProviderContext, providerDraftId: string, message: OutgoingMessage): Promise<DraftResult>;
  sendDraft?(context: ProviderContext, providerDraftId: string): Promise<SendResult>;
  send?(context: ProviderContext, message: OutgoingMessage): Promise<SendResult>;
  reply?(context: ProviderContext, original: ProviderMessage, message: Omit<OutgoingMessage, "subject" | "to">): Promise<SendResult>;
  forward?(context: ProviderContext, original: ProviderMessage, message: OutgoingMessage): Promise<SendResult>;
  archive?(context: ProviderContext, providerMessageIds: readonly string[]): Promise<void>;
  trash?(context: ProviderContext, providerMessageIds: readonly string[]): Promise<void>;
  setFlags?(context: ProviderContext, providerMessageIds: readonly string[], changes: { read?: boolean; starred?: boolean; answered?: boolean }): Promise<void>;
}

export type { MessageSummary };
