# mcp-mail-core v0.1 API Specification

**Status:** Proposed for review
**Language:** English is the normative language for this specification, all future package READMEs, public API documentation, code comments, errors, and test names.
**Implementation status:** No repository or runtime implementation is created by this document.

## 1. Purpose

`mcp-mail-core` defines the smallest provider-neutral contract for safe mail MCPs. It supports IMAP-backed and API-backed providers without requiring any provider to expose IMAP concepts, SMTP, an OAuth server, credentials, or a particular MCP SDK.

The v0.1 design has two layers:

```text
@mcp-mail/core       domain values, errors, capabilities, safety contracts
@mcp-mail/core/mcp   optional thin MCP adapter, schemas and tool registration policy
```

`@mcp-mail/core` has no runtime dependency on Zod or an MCP SDK. The optional MCP adapter may depend on them.

## 2. Normative Terms

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- A **provider** is an account-scoped implementation of one or more capabilities.
- A **reference** is an opaque, provider-owned identifier returned to a caller.
- A **mutation** changes a remote mailbox, draft, message flags, or sends external mail.
- **Untrusted content** is any content derived from a message or attachment.

## 3. Non-goals

v0.1 does not provide an IMAP provider, SMTP transport, MIME parser/composer, OAuth flow, HTTP transport, deployment code, credential/environment parsing, permanent deletion, mailbox creation, or a UI.

It does not standardize public identifier codecs, cursor codecs, Gmail query syntax, Microsoft Graph queries, labels, native conversation IDs, or attachment-file storage.

## 4. Domain Values

The following TypeScript declarations are the proposed public API. Branded strings are compile-time aids only; providers MUST still validate references at runtime.

```ts
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type MessageRef = Brand<string, "MessageRef">;
export type MailboxRef = Brand<string, "MailboxRef">;
export type AttachmentRef = Brand<string, "AttachmentRef">;

export type MailAddress = Readonly<{
  address: string;
  name?: string;
}>;

export type MessageFlags = Readonly<{
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
}>;

export type AttachmentMetadata = Readonly<{
  ref: AttachmentRef;
  filename?: string;
  mediaType: string;
  size?: number;
  disposition?: "attachment" | "inline" | string;
  contentId?: string;
}>;

export type MailboxRole =
  | "inbox" | "drafts" | "sent" | "archive" | "trash" | "junk";

export type Mailbox = Readonly<{
  ref: MailboxRef;
  displayName: string;
  role?: MailboxRole;
  selectable: boolean;
}>;

export type MessageSummary = Readonly<{
  ref: MessageRef;
  mailbox: MailboxRef;
  subject?: string;
  from: readonly MailAddress[];
  to?: readonly MailAddress[];
  receivedAt?: string;
  flags?: MessageFlags;
  snippet?: string;
  hasAttachments?: boolean;
}>;

export type Message = MessageSummary & Readonly<{
  cc: readonly MailAddress[];
  text?: string;
  html?: string;
  body: Readonly<{
    truncated: boolean;
    returnedCharacters?: number;
    totalCharacters?: number;
  }>;
  attachments: readonly AttachmentMetadata[];
  internetMessageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
}>;
```

`receivedAt` MUST be a RFC 3339/ISO 8601 instant if it is supplied. A provider MUST NOT fabricate `internetMessageId`, `inReplyTo`, `references`, HTML, size, or attachment identifiers when its source does not provide them.

`Message` body fields, display names, subject, addresses, MIME metadata, snippets, and filenames are untrusted external data. They MUST NOT be interpreted as instructions.

## 5. Search and Paging

```ts
export type SearchQuery = Readonly<{
  mailbox?: MailboxRef;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  receivedAfter?: string;
  receivedBefore?: string;
  isRead?: boolean;
  hasAttachment?: boolean;
  pageSize?: number;
  cursor?: string;
}>;

export type SearchPage = Readonly<{
  items: readonly MessageSummary[];
  nextCursor?: string;
}>;
```

Search results MUST contain summaries only and MUST NOT include full text or HTML message bodies. A provider MAY include a bounded snippet. `nextCursor`, if supplied, is opaque: consumers MUST return it unchanged and MUST NOT parse it. A provider with no pagination MUST omit it and advertise `pagination: "none"`.

The portable filter set is a minimum vocabulary, not a claim that every provider can perform identical server-side matching. Unsupported filter combinations MUST produce `CAPABILITY_UNAVAILABLE` or a documented provider extension; they MUST NOT silently broaden a query.

## 6. Outgoing Values and Results

```ts
export type OutgoingAttachment = Readonly<{
  filename: string;
  mediaType?: string;
  content:
    | Readonly<{ kind: "base64"; value: string }>
    | Readonly<{ kind: "provider-upload"; token: string }>;
  disposition?: "attachment" | "inline";
  contentId?: string;
}>;

export type SendMessageInput = Readonly<{
  to: readonly MailAddress[];
  cc?: readonly MailAddress[];
  bcc?: readonly MailAddress[];
  subject: string;
  text: string;
  html?: string;
  attachments?: readonly OutgoingAttachment[];
}>;

export type ReplyInput = Readonly<{
  message: MessageRef;
  content: Omit<SendMessageInput, "to" | "subject">;
  mode: "sender" | "all";
}>;

export type ForwardInput = Readonly<{
  messages: readonly MessageRef[];
  recipients: Pick<SendMessageInput, "to" | "cc" | "bcc">;
  note?: string;
  fidelity?: "native" | "rfc822-attachment" | "text";
}>;

export type DraftInput = Readonly<{
  content: SendMessageInput;
  replyTo?: MessageRef;
}>;

export type SendResult = Readonly<{
  messageId?: string;
  accepted?: readonly string[];
  rejected?: readonly string[];
}>;

export type DraftResult = Readonly<{
  draft: MessageRef;
}>;

export type SendDraftResult = SendResult & Readonly<{
  draftDisposition: "trashed" | "retained-after-send" | "provider-managed";
  warning?: string;
}>;

export type MoveItemResult = Readonly<{
  source: MessageRef;
  destination?: MailboxRef;
  newRef?: MessageRef;
}>;
export type MoveResult = Readonly<{ items: readonly MoveItemResult[] }>;
```

`SendMessageInput.text` is REQUIRED, even where HTML is available. The adapter MAY impose tighter operational size, recipient, attachment, and filename limits. A provider MUST reject unsafe attachment names, unsupported attachment content kinds, invalid Base64, or oversized payloads before sending.

`replaceDraft` has replacement semantics. Its input is a complete `DraftInput`, and omitted fields MUST NOT be preserved implicitly. Its returned reference MAY change. After successful SMTP/API delivery, `sendDraft` MUST return a disposition distinguishing successful cleanup from retained drafts. It MUST NOT encourage a caller to resend after a cleanup failure.

## 7. Identifier Model

The public `MessageRef`, `MailboxRef`, and `AttachmentRef` are opaque. The caller MUST use a reference only with the same account-scoped provider that produced it. A provider MUST detect stale or cross-account references before reading or mutating.

An IMAP implementation MAY use the following private locator:

```ts
export type ImapMessageLocator = Readonly<{
  mailbox: string;
  uidValidity: string;
  uid: number;
}>;
```

It MUST NOT expose this as the universal core ID model. Gmail message IDs and Microsoft Graph message IDs remain provider-native opaque values. A stale identifier MUST produce `STALE_IDENTIFIER`, not a read/mutation of a potentially different message.

## 8. Capabilities

```ts
export interface MailboxReader {
  listMailboxes(): Promise<readonly Mailbox[]>;
}

export interface MailReader {
  getMessage(
    ref: MessageRef,
    options?: Readonly<{ body?: "none" | "text" | "text-and-html" }>,
  ): Promise<Message>;
  getMessages?(refs: readonly MessageRef[]): Promise<readonly Message[]>;
}

export interface MailSearcher {
  search(query: SearchQuery): Promise<SearchPage>;
}

export type AttachmentContent =
  | Readonly<{ kind: "base64"; mediaType: string; filename?: string; value: string }>
  | Readonly<{ kind: "host-handle"; mediaType: string; filename?: string; handle: string }>;

export interface AttachmentReader {
  getAttachment(message: MessageRef, attachment: AttachmentRef): Promise<AttachmentContent>;
}

export interface MailSender {
  send(input: ConfirmedMutation<SendMessageInput>): Promise<SendResult>;
  reply(input: ConfirmedMutation<ReplyInput>): Promise<SendResult>;
  forward?(input: ConfirmedMutation<ForwardInput>): Promise<readonly SendResult[]>;
}

export interface MailDrafts {
  createDraft(input: ConfirmedMutation<DraftInput>): Promise<DraftResult>;
  replaceDraft(input: ConfirmedMutation<Readonly<{ draft: MessageRef; value: DraftInput }>>): Promise<DraftResult>;
  sendDraft(input: ConfirmedMutation<Readonly<{ draft: MessageRef }>>): Promise<SendDraftResult>;
}

export interface MailOrganizer {
  archive(input: ConfirmedMutation<Readonly<{ messages: readonly MessageRef[] }>>): Promise<MoveResult>;
  trash(input: ConfirmedMutation<Readonly<{ messages: readonly MessageRef[] }>>): Promise<MoveResult>;
  move?(input: ConfirmedMutation<Readonly<{ messages: readonly MessageRef[]; destination: MailboxRef }>>): Promise<MoveResult>;
  patchFlags(input: ConfirmedMutation<Readonly<{ messages: readonly MessageRef[]; changes: MessageFlags }>>): Promise<void>;
}

export type ThreadResult = Readonly<{
  kind: "rfc" | "native";
  messages: readonly Message[];
  truncated?: boolean;
  nativeConversationId?: string;
}>;
export interface MailThreadReader {
  getThread(message: MessageRef, options?: Readonly<{ limit?: number }>): Promise<ThreadResult>;
}
```

```ts
export type MailCapabilities = Readonly<{
  read: true;
  search?: true;
  attachments?: readonly ("base64" | "host-handle")[];
  send?: true;
  replyModes?: readonly ("sender" | "all")[];
  forwardFidelity?: readonly ("native" | "rfc822-attachment" | "text")[];
  drafts?: Readonly<{ replace: true; send: true }>;
  organizer?: Readonly<{
    archive?: true;
    trash?: true;
    move?: true;
    flags?: readonly (keyof MessageFlags)[];
  }>;
  threads?: Readonly<{ rfcHeaders?: true; nativeConversation?: true }>;
  pagination?: "opaque-cursor" | "none";
}>;

export interface MailProvider {
  readonly capabilities: MailCapabilities;
  readonly mailboxes: MailboxReader;
  readonly reader: MailReader;
  readonly searcher?: MailSearcher;
  readonly attachments?: AttachmentReader;
  readonly sender?: MailSender;
  readonly drafts?: MailDrafts;
  readonly organizer?: MailOrganizer;
  readonly threads?: MailThreadReader;
}
```

A provider MUST expose a capability object consistent with the members it supplies. A read-only provider MUST implement only `mailboxes` and `reader`, with `searcher` and `attachments` optional. The adapter MUST NOT register a mutation tool if its capability is absent.

## 9. Confirmation and Mutation Safety

```ts
export type ConfirmedMutation<T> = T & Readonly<{ confirm: true }>;
```

Every mutation MUST require a confirmation scoped to the exact call and payload. This includes send, reply, forward, draft creation/replacement/sending, archive, move, trash, and flag updates. A previous confirmation MUST NOT authorize a later call.

The optional MCP adapter MUST:

1. expose `confirm` as a required literal `true` field in every mutation input schema;
2. reject an omitted or false confirmation with `MUTATION_NOT_CONFIRMED` before the provider is invoked;
3. assign MCP annotations based on operation semantics; and
4. treat annotations as advisory metadata, never as the sole authorization mechanism.

The core calls the reversible operation `trash`, never `delete`. v0.1 MUST NOT contain a permanent-delete or expunge capability.

## 10. Errors

```ts
export type MailErrorCode =
  | "INVALID_INPUT"
  | "AUTH_FAILED"
  | "AUTHORIZATION_REQUIRED"
  | "MESSAGE_NOT_FOUND"
  | "ATTACHMENT_NOT_FOUND"
  | "MAILBOX_NOT_FOUND"
  | "STALE_IDENTIFIER"
  | "CAPABILITY_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "SEND_FAILED"
  | "MUTATION_NOT_CONFIRMED"
  | "CONFLICT";

export type MailError = Readonly<{
  code: MailErrorCode;
  message: string;
  retryable: boolean;
  action?: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}>;
```

Public errors MUST NOT expose credentials, authorization codes, access tokens, raw provider errors, full message bodies, or unredacted connection settings. `details` is optional and MUST contain only safe, actionable metadata.

## 11. Optional MCP Adapter

The MCP adapter is a convenience layer. It has a host-specific server type and is not part of the SDK-independent core contract.

```ts
export interface MutationConfirmationPolicy {
  requireExactConfirmation<T>(input: T): asserts input is ConfirmedMutation<T>;
}

export function registerMailTools(
  server: McpServerAdapter,
  provider: MailProvider,
  policy: MutationConfirmationPolicy,
): void;
```

The adapter SHOULD register neutral names: `list_mailboxes`, `search_messages`, `get_message`, `get_messages`, `get_attachment`, `get_thread`, `send_message`, `reply_message`, `create_draft`, `replace_draft`, `send_draft`, `archive_messages`, `trash_messages`, `move_messages`, and `patch_message_flags`. It MUST only register names backed by advertised capabilities.

MCP read tools MUST be `readOnlyHint: true`; mutations MUST be `readOnlyHint: false`. Send/reply/forward and account-affecting draft operations SHOULD be `openWorldHint: true`. `trash`, `move`, draft replacement/sending, and flag mutation SHOULD be destructive. Idempotency MUST be marked true only when the provider can guarantee it for the exact operation.

## 12. Compatibility Requirements

The existing iCloud and QQ MCP tool names are outside the core API. They MAY remain compatibility aliases in provider applications. An alias MUST retain the safety contract of the neutral operation it maps to.

For v0.1 conformance:

- iCloud may retain its existing opaque Base64URL IDs and keyset cursors.
- QQ may retain `account_id` at its application adapter boundary, but it MUST enforce confirmation and correct read-only semantics before advertising write capabilities through the core.
- Neither provider may claim `trash` conformance unless the operation does not permanently expunge the selected messages.

## 13. Acceptance Criteria

v0.1 is ready to implement only when all of the following are accepted:

1. This type and behavior contract is reviewed without adding provider transport/auth concerns.
2. The provider contract test specification passes for an in-memory reference provider.
3. iCloud and QQ each have an explicit capability map and gap list.
4. The MCP adapter rejection path is tested before any provider mutation test is allowed to run.
5. README and exported API documentation are written in English.
