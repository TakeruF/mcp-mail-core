# mcp-mail-core design study

**Decision:** GO WITH CONDITIONS.
**Scope of this study:** design only; no `mcp-mail-core` repository or implementation was created, and neither existing provider was changed.
**Evidence reviewed:** current source, README, package manifests, and tests in `/Users/takeru/GitHub/icloud-mail-mcp` (HEAD `8f35e38`) and `/Users/takeru/GitHub/qq-mail-mcp` (HEAD `cbaa1dd`) on 2026-08-20.

## Executive Summary

The two servers have a genuine reusable centre: provider-neutral mail values, bounded read/search contracts, message reference semantics, capability declarations, public errors, and a policy that makes mutations explicit. They should not share their current service classes or IMAP implementation by extraction. Those classes embed materially different assumptions about confirmation, retrieval safety, MIME transfer, pagination, credentials, and remote OAuth.

The recommended target is **A-shaped B**:

```text
MCP-independent mail domain and provider contracts
    + a small optional MCP adapter (schemas, registration policy, annotations)
    + provider packages/apps that own IMAP, SMTP, OAuth, deployment, and branding
```

This permits generic IMAP, read-only providers, Gmail API, and Microsoft Graph without making their native identifiers, conversations, pagination tokens, labels, or authentication look like IMAP. It also preserves the strongest existing safety property: no mutation runs unless an in-call confirmation policy accepts it.

There is a conditional rather than unconditional GO because QQ Mail currently needs an additive compatibility migration: it has only descriptive confirmation, opens mailboxes read/write even for reads, has no pagination/cursor, returns full message bodies without a core-sized limit, and writes attachment files to `/tmp`. These are implementation and adapter gaps, not reasons to force an IMAP-only abstraction.

## Current Architectures

| Area | iCloud Mail MCP 0.7.0 | QQ Mail MCP 0.1.0 | Design consequence |
|---|---|---|---|
| MCP SDK | `@modelcontextprotocol/server` v2 | `@modelcontextprotocol/sdk` v1 | Do not put a particular SDK type in the domain contracts. |
| Structure | dedicated IMAP, SMTP, tools, HTTP/OAuth, security modules | one `MailProvider` plus QQ implementation, server, HTTP/OAuth, domain | Reuse contracts, not either directory layout. |
| IMAP reads | read-only mailbox locks/EXAMINE and PEEK-style downloads | `mailboxOpen(..., { readOnly: false })` for search/read | Read-only is a provider capability and an implementation obligation. |
| SMTP | iCloud fixed host/TLS policy; structured reply, draft and RFC 822 forward | env-provided host/port; send, simplified reply/forward/draft | SMTP transport and composition stay provider-side. |
| Search | metadata/preview only, 50 default/100 max, encoded keyset cursor | up to 100 newest, no cursor; parses full source to produce a snippet | A common `SearchPage`; backend execution is provider-owned. |
| Message ID | base64url JSON `{v, mailbox, uidValidity, uid}` | visible `qqmail:<urlencoded mailbox>:<uidValidity>:<uid>` | Public IDs must be opaque and provider-owned. |
| Attachments | selected MIME part returned as base64, 5 MiB read cap | selected attachment saved as a private temp path; input cap 10 MiB each | Metadata is shared; transfer representation is capability/provider-specific. |
| Threading | iterative RFC-header discovery across bounded selectable mailboxes | RFC header reconstruction from up to 1,000 messages in one mailbox | Thread is a best-effort relation, not a universal storage primitive. |
| Safety | schema-enforced `confirm: true` on every mutation; annotations include idempotency | user-approval wording and annotations only; no `confirm` input | Core needs an enforceable mutation policy, not just prose. |
| Errors | mostly public strings/classes | structured `MailError { code, message, action }` | Adopt structured public taxonomy, map provider errors at boundary. |
| Auth/transport | app-specific password plus optional OAuth/remote HTTP | QQ authorization code plus optional OAuth/remote HTTP | These belong outside core. |

Both use ImapFlow, Nodemailer, MailParser, Zod and TypeScript, but that is an implementation coincidence. Gmail API and Graph will not use the same transport or locator semantics.

## Tool Mapping

`RO` means read-only annotation. `W` means write annotation/open-world effect. `D` means destructive annotation. iCloud tools have `idempotentHint`; QQ tools currently omit it. iCloud's `confirm: true` is required by Zod in the same invocation for every mutation. QQ has no runtime confirmation field; its descriptions ask the agent to obtain user approval.

| Concept | iCloud tool: input/output/annotation | QQ tool: input/output/annotation | Core candidate and semantic difference |
|---|---|---|---|
| Mailbox list | `list_mailboxes` → paths/name/special-use; RO | `list_mailboxes(account_id?)` → `{mailboxes}`; RO | Yes: `listMailboxes`. QQ has account selection. |
| Search | `search_mail(mailbox?, query/from/to/subject/since/before/unread, limit, cursor?)` → summaries, `nextCursor`, `hasMore`; RO | `search_emails(account_id?, query/from/to/subject/since/before/unread_only/has_attachment/mailbox/limit)` → `{emails}`; RO | Yes, but QQ lacks cursor, has attachment filter, uses datetime strings; iCloud's result guarantee is metadata/preview only. |
| Read one | `get_message(identifier)` → bounded body, HTML-presence, attachment metadata; RO | `read_email(account_id?, email_id)` → full parsed email, text+HTML and metadata; RO | Yes: `getMessage`; body projection/limits must be explicit. |
| Read batch | `get_messages(ids[1..25])` → `{messages}`; RO | `batch_read_emails(email_ids[1..20])` → `{emails}`; RO | Yes: selected-batch read; do not promise a universal max. |
| Attachment | `get_attachment(id, part)` → base64 exact MIME part, <=5 MiB; RO | `read_attachment(email_id, attachment_id? | filename?)` → private local path; RO | Partial: shared metadata/reference, but content delivery must be a separate representation. QQ filename fallback is weaker than iCloud exact-part-only selection. |
| Thread | `get_thread(id, maxMessages)` → RFC-related full messages, cross-mailbox, bounded; RO | `read_email_thread(email_id)` → RFC-header-linked emails from last 1,000 in source mailbox; RO | Potential: best-effort RFC thread reader, distinct from native conversations. |
| List drafts | `list_drafts(limit, cursor?)`; RO | none | Potential capability; not a universal reader feature. |
| Send | `send_mail(message, confirm:true)` → accepted/rejected/messageId; W | `send_email(account_id?, message)` → messageId; W | Yes: send capability. Both send immediately; iCloud validates attachment base64 with a total cap. |
| Reply | `reply_mail(id, text, html?, attachments?, replyAll, confirm:true)`; W | `reply_email(email_id, text/html/cc/bcc/attachments)`; W | Yes, with explicit recipient-resolution policy. QQ replies only to sender; iCloud supports reply-all and excludes self. |
| Forward | `forward_messages(ids[1..10], recipients, note?, confirm:true)` → each original as `message/rfc822`; W | `forward_email(email_id, recipients, note?)` → formatted text, drops original attachments; W | Potential interface only; forwarding fidelity is provider capability/option, not a single promise. |
| Create draft | `create_draft(message, replyToId?, confirm:true)`; W | `create_draft(message, reply_to_email_id?)`; W | Yes: create immutable draft. |
| Replace draft | `update_draft(id, complete message, replyToId?, confirm:true)` saves replacement then trashes old one | `update_draft(email_id, complete message, reply_to_email_id?)` appends replacement then `messageDelete`s old ID | Yes only as explicit **replace** semantics; old ID is invalid and omitted fields are not retained. QQ's delete call may be IMAP delete/expunge semantics rather than the stated Trash policy. |
| Send draft | `send_draft(id, confirm:true)` sends then moves draft to Trash; cleanup warning avoids resend | `send_draft(email_id)` sends then `messageDelete`s draft | Yes, but result must distinguish `sent` from cleanup outcome. |
| Archive | `archive_messages(ids, confirm:true)` moves to special-use Archive and returns remapped IDs when supplied; D | `archive_emails(email_ids)` moves to detected Archive or fails; D | Yes: `archive` is an organizer capability; archive location and new ID are provider-dependent. |
| Move | `move_messages(ids, destination, confirm:true)`; D | none | Potential organizer capability; Gmail label semantics must not masquerade as move. |
| Trash | `delete_messages(ids, confirm:true)` moves to special-use Trash, rejects already-Trash; D | `delete_emails(email_ids)` moves to detected Trash; D | Yes, renamed **`trashMessages`**. Neither is permanent deletion by contract. |
| Flags | `set_message_flags(ids, seen?/flagged?/answered?, confirm:true)` preserves unspecified flags; D, idempotent | `mark_read(email_ids, read)` only changes `\\Seen`; D | Yes: patch flags, with supported fields advertised. |
| Create folder | `create_mailbox(path, confirm:true)`; W/idempotent | none | Provider-specific organizer extension; not v0.1. |

The MCP adapter can provide aliases during migration, but the core names should prefer `Message`, `MessageSummary`, `MessageRef`, `trashMessages`, and `patchMessageFlags`, not provider names such as `Email` or ambiguous `delete`.

## Definitely Shared

| Contract | Why / current evidence | IMAP / Gmail / Outlook feasibility |
|---|---|---|
| `MailAddress`, `MessageSummary`, `Message`, attachment metadata, mailbox summary | Both parse addresses, summary metadata, bodies and attachment metadata. | All three have equivalents. Native fields can remain extensions. |
| `MessageRef` as opaque public ID | Both protect against UID reuse with mailbox+UIDVALIDITY+UID. | Gmail/Graph use native opaque IDs; all can expose an opaque core string. |
| selected-message reads | Both distinguish search from one/batch reads. | Universal and naturally read-only. |
| `SearchQuery` and `SearchPage<T>` | Both filter by mailbox, text/header/date/read state and bound result count. | Common subset works; provider may advertise more filters. |
| mailbox discovery plus special-use classification | Both list folders and resolve Drafts/Archive/Trash. | Gmail labels and Graph folders can map to canonical roles with caveats. |
| send / reply / draft contracts | Both use MIME/SMTP-style composition and expose these user intents. | Gmail/Graph support direct equivalent operations. |
| `trashMessages`, archive, flag patch as separate operations | Both operate on selected references and do not offer permanent deletion. | API providers map to trash/archive/flag operations, potentially with different native semantics. |
| capability declarations | Necessary for iCloud/QQ feature differences and read-only providers. | Essential for API providers and optional features. |
| public `MailError` taxonomy plus action/retry guidance | Both need safe conversion of low-level errors. | Universal boundary. |
| untrusted-content marking | Both explicitly treat text/HTML/attachments as untrusted. | Universal security property. |

## Potentially Shared

| Contract | iCloud / QQ reality | Generic IMAP / Gmail / Outlook assessment |
|---|---|---|
| RFC thread reader | iCloud searches cross-mailbox iteratively; QQ reconstructs from header references in one mailbox. | Exists everywhere but native Gmail threadId and Graph conversationId are stronger/different. Make it best-effort and optional. |
| draft lifecycle | Both create replacement drafts and send drafts, but cleanup differs; both replace, not patch. | Viable with explicit state/outcome. Gmail and Graph have native draft IDs and update APIs. |
| attachment content reader | Both expose metadata then retrieve a selected attachment. | Viable if return is a stream/handle or explicitly bounded content; not a fixed base64/path shape. |
| special-use resolver | iCloud relies on IMAP special-use. QQ additionally falls back to English/Chinese names. | IMAP supports it; Gmail/Graph use native folders/labels. Resolver belongs in provider support code. |
| full-text / attachment search | iCloud supports IMAP TEXT; QQ exposes `has_attachment`. | Gmail search syntax and Graph `$search` differ materially. Use portable filters plus declared extensions. |
| result snippets | Both emit a short snippet, QQ after full MIME parsing. | Support where available; never promise body completeness. |

## Provider-specific

| Area | iCloud | QQ | Generic IMAP / Gmail / Outlook implication |
|---|---|---|---|
| Host, TLS, auth secret | fixed iCloud IMAP/SMTP settings and Apple app-specific password | env-configured QQ hosts and QQ authorization code | Must remain provider configuration. Gmail/Graph OAuth differs completely. |
| Message locator codec | versioned base64url JSON | `qqmail:` colon codec | Keep codec private to providers; native API IDs must not be reverse-engineered. |
| raw MIME forwarding | complete source as `message/rfc822` attachment | textual forward body only | Advertise fidelity, do not normalize behavior. |
| attachment delivery | base64 MCP payload | local temporary file | Adapter/provider policy; UI/client security matters. |
| read-mode workaround | trusts requested EXAMINE due to iCloud/ImapFlow flag misclassification | currently opens read/write | Service-specific reliability workarounds never belong in core. |
| folder name fallback | special-use only | localized Chinese/English fallbacks | Provider layer may implement locale/service mappings. |
| OAuth/HTTP | custom OAuth store/server, Vercel routing | Express OAuth/PKCE implementation | Deployment integration is not mail domain. |
| multi-account selection | one configured mailbox identity | `account_id` every tool | Account resolution is adapter/application concern. |

## Do Not Abstract

Do not create a giant `MailProvider` like QQ's current interface. It forces every provider to pretend it can search, read attachments, write, organize, draft, and reconstruct RFC threads. In particular, do not abstract:

- IMAP client lifecycle, locks, `EXAMINE`, PEEK, UID mapping, IMAP search syntax, or ImapFlow types.
- SMTP/Nodemailer configuration and MIME composer/parser internals.
- public-ID encoding or cursor encoding algorithms.
- exact tool titles, marketing/branding, account environment variables, hosts or locale fallback lists.
- a universal folder path model: Gmail labels, Graph folders, and IMAP mailboxes have different semantics.
- arbitrary provider-native search query languages as a common string.
- one global `Thread` identity: RFC headers, Gmail thread IDs, and Graph conversation IDs are different relations.
- inline Base64 versus temp-file attachment delivery.
- HTTP transport, OAuth issuer/client registration/token storage, Vercel/Docker deployment, or credential parsing.
- permanent deletion/expunge in v0.1.

## Domain Model Proposal

Use `Message` consistently. `Mail` is the namespace/product; `Email` is avoided in public types except where a provider SDK requires it.

```ts
export type MailAddress = Readonly<{ address: string; name?: string }>;

export type MessageRef = string & { readonly __brand: "MessageRef" };
export type AttachmentRef = string & { readonly __brand: "AttachmentRef" };
export type MailboxRef = string & { readonly __brand: "MailboxRef" };

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

export type MessageSummary = Readonly<{
  ref: MessageRef;
  mailbox: MailboxRef;
  subject?: string;
  from: readonly MailAddress[];
  to?: readonly MailAddress[];
  receivedAt?: string; // RFC 3339 instant
  flags?: MessageFlags;
  snippet?: string;
  hasAttachments?: boolean;
}>;

export type Message = MessageSummary & Readonly<{
  cc: readonly MailAddress[];
  text?: string;
  html?: string;
  body: { truncated: boolean; returnedCharacters?: number; totalCharacters?: number };
  attachments: readonly AttachmentMetadata[];
  internetMessageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
}>;

export type OutgoingAttachment = Readonly<{
  filename: string;
  mediaType?: string;
  content: { kind: "base64"; value: string } | { kind: "provider-upload"; token: string };
  disposition?: "attachment" | "inline";
  contentId?: string;
}>;

export type Mailbox = Readonly<{
  ref: MailboxRef;
  displayName: string;
  role?: "inbox" | "drafts" | "sent" | "archive" | "trash" | "junk";
  selectable: boolean;
}>;

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
export type SearchPage = Readonly<{ items: readonly MessageSummary[]; nextCursor?: string }>;

export type SendMessageInput = Readonly<{
  to: readonly MailAddress[]; cc?: readonly MailAddress[]; bcc?: readonly MailAddress[];
  subject: string; text: string; html?: string; attachments?: readonly OutgoingAttachment[];
}>;
export type ReplyInput = Readonly<{ message: MessageRef; content: Omit<SendMessageInput, "to" | "subject">; mode: "sender" | "all" }>;
export type ForwardInput = Readonly<{ messages: readonly MessageRef[]; recipients: Pick<SendMessageInput, "to" | "cc" | "bcc">; note?: string; fidelity?: "native" | "rfc822-attachment" | "text" }>;
export type DraftInput = Readonly<{ content: SendMessageInput; replyTo?: MessageRef }>;
```

`text` and `html` are data, not instructions. `Message` deliberately does not guarantee HTML, a native thread ID, attachment bytes, or a body of unlimited length.

## Capability Interfaces

The application receives a `MailProvider` composition, not an inheritance-heavy mega-interface:

```ts
export interface MailReader {
  getMessage(ref: MessageRef, options?: { body?: "none" | "text" | "text-and-html" }): Promise<Message>;
  getMessages?(refs: readonly MessageRef[]): Promise<readonly Message[]>;
}
export interface MailSearcher { search(query: SearchQuery): Promise<SearchPage>; }
export interface MailboxReader { listMailboxes(): Promise<readonly Mailbox[]>; }
export interface AttachmentReader { getAttachment(ref: MessageRef, attachment: AttachmentRef): Promise<AttachmentContent>; }
export interface MailSender { send(input: ConfirmedMutation<SendMessageInput>): Promise<SendResult>; reply(input: ConfirmedMutation<ReplyInput>): Promise<SendResult>; }
export interface MailDrafts { createDraft(input: ConfirmedMutation<DraftInput>): Promise<DraftResult>; replaceDraft(input: ConfirmedMutation<{ draft: MessageRef; value: DraftInput }>): Promise<DraftResult>; sendDraft(input: ConfirmedMutation<{ draft: MessageRef }>): Promise<SendDraftResult>; }
export interface MailOrganizer { archive(input: ConfirmedMutation<{ messages: readonly MessageRef[] }>): Promise<MoveResult>; trash(input: ConfirmedMutation<{ messages: readonly MessageRef[] }>): Promise<MoveResult>; patchFlags(input: ConfirmedMutation<{ messages: readonly MessageRef[]; changes: MessageFlags }>): Promise<void>; }
export interface MailThreadReader { getRfcThread?(message: MessageRef, options?: { limit?: number }): Promise<ThreadResult>; }

export type MailCapabilities = Readonly<{
  read: true; search?: true; attachments?: AttachmentDelivery[]; send?: true; replyModes?: readonly ("sender" | "all")[];
  drafts?: { replace: true; send: true }; organizer?: { archive?: true; trash?: true; move?: true; flags?: readonly (keyof MessageFlags)[] };
  threads?: { rfcHeaders?: true; nativeConversation?: true }; pagination?: "opaque-cursor" | "none";
}>;
```

This is deliberately a small set: read, search, mailboxes, attachments, send/drafts, organizer, and thread reader. A read-only provider implements only the first three (and possibly attachments); no fake writer methods or unsupported errors are required. `capabilities` is the advertised feature set used by the MCP adapter before tool registration or invocation.

## Identifier Model

Keep four layers separate.

1. **Provider-neutral logical identifier:** `MessageRef`, an opaque string passed back only to the same provider/account. It has no mandated internal structure.
2. **IMAP locator:** provider-private `ImapMessageLocator { mailbox: string; uidValidity: string; uid: number }`. Both current servers effectively use this and validate UIDVALIDITY before reading/mutating. `uidValidity` should remain a decimal string to avoid JavaScript number precision loss.
3. **Public MCP identifier:** the serialized `MessageRef` emitted by the adapter. Its codec is provider-private/versioned. iCloud currently uses base64url JSON; QQ uses a prefixed colon form. Do not centralize either.
4. **Provider-native identifier:** Gmail message ID/threadId and Graph message ID/conversationId. Preserve as opaque values inside each provider; never force them into the IMAP tuple.

Cursor tokens use the same rule: `SearchPage.nextCursor` is opaque. iCloud's encoded cursor contains filters, UIDVALIDITY and a UID keyset boundary; Gmail/Graph continuation tokens must be passed through untouched. The adapter rejects changed search filters only where the provider's cursor semantics require it.

## Safety Model

### Current state

- iCloud marks reads as `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:true`; every mutation has `readOnlyHint:false`, every send/reply/forward/draft is open-world, and organizer/replace/send-draft/flags carry destructive hints as appropriate. Its Zod schemas require literal `confirm: true` on the same call.
- QQ marks reads read-only and mutations as either write/open-world or destructive/non-open-world. It has no `idempotentHint` values and does **not** require a confirmation value at runtime. Its tool descriptions request explicit user approval but cannot enforce it.

### Decision

Use **confirmation required** for every externally visible mutation: send, reply, forward, create/replace/send draft, archive, move, trash, permanent delete (if ever added), and flag changes. This belongs in the core's safety contract, while the MCP adapter supplies the `confirm: true` input and annotations. It is not merely outside-core policy: an API caller must not accidentally receive a write method that looks like an ordinary read.

```ts
export type ConfirmedMutation<T> = T & Readonly<{ confirm: true }>;
```

At runtime, an adapter validates `confirm === true` immediately before invoking the capability. A non-MCP host may obtain this branded value only through its own explicit approval gate. It must be single-call/single-payload authorization: no cached consent, no approval inferred from a prior message, and no reuse after recipients, body, IDs, destination, or flag patch changes.

Annotations are advisory metadata, not the authorization control. The thin MCP layer should assign `readOnlyHint`, `destructiveHint`, `openWorldHint`, and `idempotentHint` based on the operation semantics and provider capability. No write should default to idempotent; flag patches and create-folder may be idempotent only when their providers can prove it.

`trashMessages` should replace the user-facing `delete` intent. A future `permanentlyDeleteMessages` is a distinct opt-in `PermanentDeletion` capability with stricter confirmation, explicit permanence wording, provider retention checks, and never part of v0.1.

## Search & Pagination

The default agent flow is **search → select → fetch body/attachment**. `SearchPage.items` must be summaries and must not include full text or HTML bodies. A short bounded `snippet` is permitted, and providers should disclose absent/estimated snippets rather than fetch all source just to fabricate one. `getMessage` owns full-body retrieval and must offer a bounded projection with `truncated` metadata.

Portable filters are mailbox, free text, sender, recipient, subject, date range, read state, attachment presence, and page size. Filters such as Gmail search syntax, Graph `$filter`, labels, and service ranking are declared provider extensions rather than overloaded into `text`.

Pagination is optional capability behavior. The shared output is:

```ts
type Page<T> = { items: readonly T[]; nextCursor?: string };
```

Cursor values are opaque. iCloud maps this directly. QQ v0.1 reports no `nextCursor`; it should either explicitly advertise `pagination: "none"` or gain an additive opaque IMAP UID keyset cursor. Do not invent offset cursors in core.

## MIME & Attachments

Core owns typed boundaries and safety requirements, not MailParser/MailComposer implementations:

- Providers parse MIME and compose outgoing MIME; they map plain text, HTML, attachment metadata, inline disposition/CID and RFC 822 source to core values where available.
- The core validates portable outgoing attachment shape, byte limits configured by the adapter, safe display filename, declared media type, and strict Base64 when `kind: "base64"` is offered.
- Providers must disable untrusted file/URL resolution in composer paths and must not execute HTML/scripts or load remote content.
- Attachment reads use an explicit delivery union, e.g. bounded Base64 bytes, a host-approved private handle, or provider download token. A raw local filesystem path must not be assumed portable.
- Temporary-file lifecycle, filesystem permissions, streaming, and exact size limits are provider/app concerns. iCloud currently returns <=5 MiB Base64; QQ currently creates a 0600 temp file and needs cleanup/lifecycle policy.

RFC 822 forwarding is a provider capability (`fidelity: "rfc822-attachment"`), not a promise that every forward preserves MIME structure.

## Thread Model

There are three distinct concepts:

1. **RFC message thread:** best-effort graph from `Message-ID`, `In-Reply-To`, and `References`. This is what both current servers implement, with different search bounds.
2. **Provider-native conversation:** Gmail `threadId` and Graph `conversationId`; native and generally more complete within their service.
3. **Subject grouping:** never treat it as a thread. QQ explicitly avoids it.

`Thread` is useful only as an optional read result, not an identity every message must carry:

```ts
type ThreadResult = {
  kind: "rfc" | "native";
  messages: readonly Message[];
  truncated?: boolean;
  nativeConversationId?: string;
};
```

MCP can expose `get_thread` only when the provider advertises this capability, with an explicit result limit and truncation signal.

## Draft Semantics

Both current implementations are **replace**, not partial-update, designs. The core must say so: `replaceDraft` receives a complete new `DraftInput`; omitted recipients, bodies, headers and attachments are removed rather than retained. Result IDs can change.

The required outcome model is:

```ts
type SendDraftResult = SendResult & {
  draftDisposition: "trashed" | "retained-after-send" | "provider-managed";
  warning?: string;
};
```

iCloud already correctly distinguishes SMTP success from cleanup failure and warns not to resend. QQ should adopt the same result semantics and confirm whether its `messageDelete` is a trash move or permanent IMAP deletion. A send failure must preserve the draft. Reply context and attachment retention are composition/provider responsibilities, represented as inputs and outcomes rather than hidden side effects.

## Error Taxonomy

Use a typed, provider-neutral public error at the boundary. Do not leak ImapFlow, SMTP, OAuth, host, credential, raw provider messages, or secret-bearing strings.

```ts
type MailErrorCode =
  | "INVALID_INPUT" | "AUTH_FAILED" | "AUTHORIZATION_REQUIRED"
  | "MESSAGE_NOT_FOUND" | "ATTACHMENT_NOT_FOUND" | "MAILBOX_NOT_FOUND"
  | "STALE_IDENTIFIER" | "CAPABILITY_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED"
  | "SEND_FAILED" | "MUTATION_NOT_CONFIRMED" | "CONFLICT";

type MailError = Readonly<{
  code: MailErrorCode;
  message: string;
  retryable: boolean;
  action?: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}>;
```

Map iCloud `MailboxChangedError` and QQ `UIDVALIDITY_CHANGED` to `STALE_IDENTIFIER`; iCloud `MessageNotFoundError` and QQ `EMAIL_NOT_FOUND` to `MESSAGE_NOT_FOUND`; QQ `AUTHENTICATION_FAILED` to `AUTH_FAILED`; IMAP/SMTP connection failures to `PROVIDER_UNAVAILABLE` or `SEND_FAILED` by operation. Keep the existing human action guidance, but redact it and make retryability explicit.

## Untrusted Content Contract

The domain labels all message-derived values (`subject`, names, addresses, bodies, HTML, header-derived IDs, filenames, MIME types, snippets and attachment metadata) as untrusted external data. The provider parses it but never executes it. The MCP adapter must state that messages/attachments are data, never instructions, and should return provenance such as `source: "external-email"` where SDK support exists. The host/agent must not follow instructions embedded in mail without independent user authorization.

Core should provide the policy/types and redaction helpers, not HTML rendering, antivirus scanning, sandbox execution, or attachment storage.

## Auth Boundary

Do not implement Apple app-specific passwords, QQ authorization codes, Gmail OAuth, Microsoft OAuth, environment parsing, Vercel authentication, or Streamable HTTP OAuth in core. A small optional integration seam is sufficient:

```ts
interface AccountResolver<AccountContext> { resolve(account: string): Promise<AccountContext>; }
interface CredentialProvider<Credential> { get(account: AccountContext): Promise<Credential>; }
```

These interfaces belong in an integration package only if multiple providers genuinely use them. Core operations should receive an already-authorized provider instance; that avoids treating credentials as mail domain values and keeps secret lifetime/logging under the host's control.

## MCP Boundary

| Option | Assessment |
|---|---|
| A. Mail domain core only | Most stable, works for any transport and provider, but each server duplicates safe Zod/tool registration. |
| B. MCP mail core | Valuable only when split into A plus a thin optional adapter. Schemas/tool helpers can preserve consistent safety without leaking SDK types into A. |
| C. Full framework | Rejected. It couples hosting, OAuth, deployment, credentials and provider quirks, and would prevent API-native providers from fitting cleanly. |

Adopt **A plus optional B**. `@mcp-mail/core` must have no MCP SDK or Zod dependency. A small `@mcp-mail/mcp` can depend on `core`, Zod and a chosen MCP SDK, define public schemas, attach annotations and enforce `confirm`. It should accept capability implementations and not know IMAP/SMTP.

## Proposed Package Structure

Start as one repository with internal modules to avoid package proliferation:

```text
mcp-mail-core/                         # future repository; not created by this study
  src/
    domain/                             # values and result types
    contracts/                          # small capability interfaces
    capabilities/                       # capability declarations
    identifiers/                        # opaque-brand primitives, not codecs
    safety/                             # confirmation and untrusted-content policy
    errors/                             # public taxonomy and mapper helpers
    schemas/                            # optional, only if core has a Zod-free companion boundary
    mcp/                                # optional adapter: registration/schema/annotations
    testing/                            # provider contract fixtures/tests
```

At first publish as a single `@mcp-mail/core` package with an export such as `@mcp-mail/core/mcp` only if peer dependency and versioning remain simple. Split later into `@mcp-mail/core`, `@mcp-mail/mcp`, and `@mcp-mail/imap` only when at least two independently released consumers demonstrate the boundary. `@mcp-mail/imap` must never be required by Gmail/Graph providers.

# What we should NOT put in mcp-mail-core

- Provider hosts, ports, TLS knobs, server-specific IMAP options, service-specific EXAMINE workarounds, or localized folder-name fallbacks.
- Apple app-specific-password handling, QQ authorization-code handling, Gmail/Microsoft OAuth, account environment variables, parsing of `.env`, or secret logging/redaction policy tied to a deployment.
- OAuth authorization server, token store, Dynamic Client Registration, HTTP/stdio transport, Express/Vercel/Docker code, callback CSP, or public URL configuration.
- Provider branding, server name/version, tool titles, README setup, provider-specific tool aliases, and user-facing env variable names.
- ImapFlow/Nodemailer/MailParser objects and parser/composer implementation, temp-file management, or raw attachment download mechanisms.
- iCloud/QQ public ID and cursor codecs, native Gmail/Graph IDs, or a lossy universal conversation/folder abstraction.
- Permanent deletion/expunge, bulk migration, retention policy, or any automatic execution of untrusted message content.

## Migration Plan

### iCloud Mail

Keep: its IMAP read-only locks/EXAMINE workaround, base64url locator/cursor codecs, MIME parsing/composition, special-use handling, bounded search/read behavior, remote OAuth, and every current tool as a compatibility adapter.

Change additively: map `MailService`/`MailSender` into capability implementations; emit core `Message` values; map existing `identifier` to opaque `MessageRef`; use the common error mapper; expose `trashMessages` internally while retaining `delete_messages` as an alias/deprecated MCP surface. Preserve the existing `confirm:true` safety behavior exactly. Do not weaken attachment/body limits or replace the iCloud-specific read-only compatibility fix.

### QQ Mail

Keep: QQ credential provider, IMAP/SMTP hosts, QQ locator codec, localized special-use resolver, user account selection, and QQ remote OAuth/HTTP implementation.

Required additive changes before calling it core-conformant:

1. Add literal `confirm:true` validation to every mutation schema and enforce it before provider invocation.
2. Open read operations with IMAP read-only semantics/PEEK; use explicit writable locks only for mutations.
3. Introduce bounded message body projections and an opaque cursor or advertise pagination absent until it is implemented.
4. Change public intent/tool alias from `delete_emails` to `trash_messages`; verify `update_draft` and `send_draft` cleanup never perform permanent deletion contrary to their description.
5. Return structured `SendDraftResult` cleanup state; distinguish send success from draft cleanup failure.
6. Prefer exact attachment reference over filename selection; define temp-file cleanup/host-safe delivery before exposing a portable attachment capability.
7. Fill `idempotentHint` based on proven behavior and map all errors to the shared taxonomy without disclosing credentials.

Migration sequence: first add contract tests and adapters beside existing tools; second expose new neutral tool names as opt-in aliases; third migrate documentation/clients; only then deprecate legacy aliases on a major version. No existing public ID should be re-encoded during a compatibility release.

## Open Questions

1. Should the optional MCP adapter use Zod 4 only, or generate JSON Schema to avoid coupling all providers to a Zod major version?
2. What attachment delivery mechanisms are safe for the actual target MCP hosts: bounded inline bytes, an approved artifact handle, or user-mediated download only?
3. What capability test can prove the QQ `messageDelete` behavior against a real mailbox without risking permanent loss?
4. How should account identity be namespaced so an opaque `MessageRef` from one account cannot be used with another account/provider?
5. Should `create_draft` require confirmation in every host, or may a trusted UI acquire a narrowly-scoped `ConfirmedMutation` token? Recommended default: require it.
6. Which native Gmail/Graph features should remain provider extensions rather than broaden the portable query/folder model?

## Recommended v0.1 Scope

Include only:

1. Zod-free domain types: addresses, summaries/messages, mailboxes, flags, attachment metadata, search page, outgoing/draft/reply inputs, opaque refs.
2. Small capability interfaces and `MailCapabilities`, designed so a read-only implementation is natural.
3. `ConfirmedMutation` runtime policy contract and untrusted-content policy.
4. Public error taxonomy/mapping requirements.
5. Identifier primitives (`MessageRef`, `MailboxRef`, `AttachmentRef`) and explicit IMAP locator type in an IMAP-specific module—not a public codec.
6. Provider contract tests: stale reference, read-only read, bounded search/body, confirmation rejection, trash-not-permanent-delete, draft send/cleanup outcome, error redaction.
7. A thin, optional MCP adapter that supplies neutral schemas, annotations and tool registration from capabilities.

Not in v0.1:

- IMAP, SMTP, MIME parser/composer implementations, generic IMAP provider, Gmail/Graph provider, OAuth/transport/deployment, credential/env logic, temp file handling.
- Public ID/cursor codecs, provider search DSLs, native conversation models, label/folder normalization, permanent deletion, mailbox creation, forwarding-fidelity normalization, or a UI.

## Next v0.1 API Surface (design only)

```ts
export type { MessageRef, MailboxRef, AttachmentRef, MailAddress, MessageSummary, Message,
  AttachmentMetadata, Mailbox, MessageFlags, SearchQuery, SearchPage, SendMessageInput,
  ReplyInput, ForwardInput, DraftInput, MailError, MailCapabilities, ConfirmedMutation };

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

// optional @mcp-mail/core/mcp surface
export function registerMailTools(server: McpServerAdapter, provider: MailProvider, policy: MutationConfirmationPolicy): void;
```

The `McpServerAdapter` should be structural/minimal or live in the MCP package, never exported from the SDK-independent domain package. The next implementation task, if approved, is a contract-test-first prototype in a new repository—not a wholesale extraction from either server.
