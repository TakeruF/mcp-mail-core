export type ProviderId = "gmail" | "qq" | "icloud" | (string & {});
export type AccountStatus = "ready" | "reauthorization_required" | "disabled" | "error";

export type MailCapabilities = Readonly<{
  search: true;
  nativeSearch: boolean;
  threads: "native" | "rfc-headers" | false;
  labels: boolean;
  folders: boolean;
  attachments: boolean;
  drafts: boolean;
  send: boolean;
  reply: boolean;
  forward: boolean;
  archive: boolean;
  trash: boolean;
  permanentDelete: boolean;
  flags: readonly ("read" | "starred" | "answered")[];
}>;

export type MailAccount = Readonly<{
  id: string;
  provider: ProviderId;
  label: string;
  roles: readonly string[];
  capabilities: MailCapabilities;
  status: AccountStatus;
  providerIdentity?: string;
}>;

/** Internal metadata. credentialId is never returned through the public account API. */
export type RegisteredAccount = MailAccount & Readonly<{ credentialId: string }>;

export type MailAddress = Readonly<{ name?: string; address: string }>;
export type MessageRef = Readonly<{ accountId: string; messageId: string }>;
export type ThreadRef = Readonly<{ accountId: string; threadId: string }>;
export type AttachmentRef = Readonly<{ accountId: string; messageId: string; attachmentId: string }>;
export type DraftRef = Readonly<{ accountId: string; draftId: string }>;

export type SearchQuery = Readonly<{
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  hasAttachment?: boolean;
  folder?: string;
  labels?: readonly string[];
  nativeQuery?: string;
}>;

export type MessageSummary = Readonly<{
  ref: MessageRef;
  threadRef?: ThreadRef;
  subject: string;
  from: readonly MailAddress[];
  to: readonly MailAddress[];
  receivedAt?: string;
  unread: boolean;
  starred: boolean;
  snippet: string;
  hasAttachments: boolean;
  labels?: readonly string[];
  folder?: string;
}>;

export type AttachmentMetadata = Readonly<{
  ref: AttachmentRef;
  filename?: string;
  contentType: string;
  size?: number;
}>;

export type MessageDetail = MessageSummary & Readonly<{
  cc: readonly MailAddress[];
  replyTo: readonly MailAddress[];
  bodyText: string;
  bodyTruncated: boolean;
  attachments: readonly AttachmentMetadata[];
  internetMessageId?: string;
  inReplyTo?: string;
  references: readonly string[];
}>;

export type ProviderMessageSummary = Omit<MessageSummary, "ref" | "threadRef"> & Readonly<{
  providerMessageId: string;
  providerThreadId?: string;
}>;

export type ProviderSearchPage = Readonly<{
  messages: readonly ProviderMessageSummary[];
  nextCursor?: string;
}>;

export type AccountSearchPage = Readonly<{
  accountId: string;
  messages: readonly MessageSummary[];
  nextCursor?: string;
}>;

export type AccountFailure = Readonly<{
  accountId: string;
  code: string;
  message: string;
  retryable: boolean;
}>;

export type CrossAccountSearchPage = Readonly<{
  pages: readonly AccountSearchPage[];
  failures: readonly AccountFailure[];
  nextCursor?: string;
}>;

export type OutgoingAttachment = Readonly<{
  filename: string;
  contentType?: string;
  contentBase64: string;
}>;

export type OutgoingMessage = Readonly<{
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  text: string;
  attachments?: readonly OutgoingAttachment[];
}>;

export type ReplyMessage = Omit<OutgoingMessage, "subject" | "to"> & Readonly<{ replyAll?: boolean }>;

export type Confirmed<T> = T & Readonly<{ confirm: true }>;
