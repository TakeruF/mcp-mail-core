# mcp-mail-core v0.1 Reference Implementation Report

**Status:** Proposed for review.
**Purpose:** demonstrate that the proposed v0.1 contract can be implemented naturally in TypeScript without implementing a transport, authentication flow, provider migration, or publishable package.
**Related documents:** [design study](./mcp-mail-core-design-study.md), [API specification](./mcp-mail-core-v0.1-api-spec.md), and [provider contract test specification](./mcp-mail-core-v0.1-provider-contract-tests.md).

## 1. Executive Summary

The v0.1 design is implementable as a small, dependency-free TypeScript domain layer. Its central design choice works in practice: a `MailProvider` is a composition of small capability objects, rather than a mandatory interface that makes every provider imitate IMAP, SMTP, drafts, organizing, or threads.

The reference examples below use branded opaque references, runtime stale-reference checks, opaque search cursors, structured public errors, and an in-memory read-only provider. They preserve the intended agent flow:

```text
search -> select a MessageRef -> fetch the selected body or attachment
```

The optional MCP adapter is deliberately thin. It exposes only declared capabilities, requires `confirm: true` at the call boundary for every mutation, and uses annotations as advisory metadata rather than authorization. No example below connects to a mail service, parses MIME, sends SMTP, implements OAuth, or exposes provider credentials.

## 2. Scope and Non-goals

This report is a reviewable reference design, not source code for an npm package. It covers domain declarations, a deterministic in-memory reader/searcher, capability composition, adapter boundaries, and contract-test examples.

It does not implement or prescribe IMAP, SMTP, MIME parsing or composing, OAuth, HTTP/MCP transport, deployment, credential loading, provider host configuration, a public identifier codec, a cursor codec, folder-name heuristics, or permanent deletion. It does not claim that iCloud Mail MCP or QQ Mail MCP is currently conformant.

## 3. Proposed Source Tree

The following future tree keeps the SDK-independent portion small. `mcp/` is optional and may have MCP/Zod dependencies; the remaining modules do not.

```text
src/
  domain/
    types.ts                 # refs, values, inputs, and results
  contracts/
    capabilities.ts          # small interfaces and MailProvider composition
  safety/
    confirmation.ts          # ConfirmedMutation and runtime assertion
    untrusted-content.ts     # data-only policy helpers
  errors/
    mail-error.ts            # public taxonomy and safe boundary mapper
  reference/
    in-memory-read-only.ts   # deterministic read/search/list example
  testing/
    contract.ts              # fixture type and reusable contract suite
  mcp/
    register-mail-tools.ts   # optional capability-driven adapter
index.ts                     # SDK-independent public exports
mcp.ts                       # optional @mcp-mail/core/mcp export
```

The tree is a module boundary, not a mandate to publish several packages. Provider adapters own all provider SDKs, transports, ID codecs, authentication, and deployment outside this tree.

## 4. Public Export Surface

The root export remains provider-neutral. In particular, it exports no IMAP client, SMTP client, OAuth type, provider hostname, or MCP server type.

```ts
// src/index.ts
export type {
  AttachmentContent, AttachmentMetadata, AttachmentRef, ConfirmedMutation,
  DraftInput, DraftResult, ForwardInput, MailAddress, MailCapabilities,
  Mailbox, MailboxRef, MailboxRole, MailError, MailErrorCode, MailOrganizer,
  MailProvider, MailReader, MailSearcher, MailSender, MailboxReader,
  Message, MessageFlags, MessageRef, MessageSummary, MoveResult,
  OutgoingAttachment, ReplyInput, SearchPage, SearchQuery, SendDraftResult,
  SendMessageInput, SendResult,
} from "./domain/types.js";
export { assertConfirmedMutation, toMailError } from "./safety/confirmation.js";
export { mapProviderError } from "./errors/mail-error.js";
export { createInMemoryReadOnlyProvider } from "./reference/in-memory-read-only.js";
```

The optional adapter has a separate entry point so consumers that need only domain contracts do not acquire an MCP SDK dependency.

```ts
// src/mcp.ts
export { registerMailTools } from "./mcp/register-mail-tools.js";
export type { McpServerLike, ToolAnnotations } from "./mcp/register-mail-tools.js";
```

## 5. Reference TypeScript Implementation Examples

The following declarations are intentionally close to the API specification. Brands improve compile-time separation but never replace runtime validation by an adapter.

```ts
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type MessageRef = Brand<string, "MessageRef">;
export type MailboxRef = Brand<string, "MailboxRef">;
export type AttachmentRef = Brand<string, "AttachmentRef">;

export type MailAddress = Readonly<{ address: string; name?: string }>;
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

Search only returns `MessageSummary`. `text` and `html` exist only on a selected `Message`; all message-derived strings remain untrusted external data.

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
export type DraftInput = Readonly<{ content: SendMessageInput; replyTo?: MessageRef }>;
export type SendResult = Readonly<{
  messageId?: string;
  accepted?: readonly string[];
  rejected?: readonly string[];
}>;
export type DraftResult = Readonly<{ draft: MessageRef }>;
export type SendDraftResult = SendResult & Readonly<{
  draftDisposition: "trashed" | "retained-after-send" | "provider-managed";
  warning?: string;
}>;
export type MoveResult = Readonly<{
  items: readonly Readonly<{
    source: MessageRef;
    destination?: MailboxRef;
    newRef?: MessageRef;
  }>[];
}>;
```

## 6. In-memory Reference Provider

This provider demonstrates that read-only implementations need no stubs for writes. Its cursor is an implementation-private offset token; callers return it unchanged and never decode it. A production provider may encode a keyset token differently.

```ts
export type MailboxReader = { listMailboxes(): Promise<readonly Mailbox[]> };
export type MailReader = {
  getMessage(
    ref: MessageRef,
    options?: Readonly<{ body?: "none" | "text" | "text-and-html" }>,
  ): Promise<Message>;
};
export type MailSearcher = { search(query: SearchQuery): Promise<SearchPage> };

const asMessageRef = (value: string): MessageRef => value as MessageRef;
const asMailboxRef = (value: string): MailboxRef => value as MailboxRef;

function summaryOf(message: Message): MessageSummary {
  const { cc: _cc, text: _text, html: _html, body: _body, attachments: _attachments,
    internetMessageId: _id, inReplyTo: _reply, references: _refs, ...summary } = message;
  return summary;
}

function opaqueOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^mem-page:[0-9]+$/u.test(cursor)) {
    throw { code: "INVALID_INPUT", message: "Invalid search cursor.", retryable: false } satisfies MailError;
  }
  return Number(cursor.slice("mem-page:".length));
}

export function createInMemoryReadOnlyProvider(seed: {
  mailboxes: readonly Mailbox[];
  messages: readonly Message[];
}): MailProvider {
  const byRef = new Map(seed.messages.map((message) => [message.ref, message]));
  const mailboxes: MailboxReader = {
    async listMailboxes() { return seed.mailboxes; },
  };
  const reader: MailReader = {
    async getMessage(ref, options = {}) {
      const message = byRef.get(ref);
      if (!message) throw staleOrMissing(ref);
      const body = options.body ?? "text-and-html";
      if (body === "none") return { ...message, text: undefined, html: undefined };
      if (body === "text") return { ...message, html: undefined };
      return message;
    },
  };
  const searcher: MailSearcher = {
    async search(query) {
      const pageSize = Math.min(query.pageSize ?? 20, 50);
      const offset = opaqueOffset(query.cursor);
      const needle = [query.text, query.subject, query.from].filter(Boolean).join(" ").toLowerCase();
      const matched = seed.messages.filter((message) =>
        (query.mailbox === undefined || message.mailbox === query.mailbox) &&
        (query.isRead === undefined || message.flags?.seen === query.isRead) &&
        (query.hasAttachment === undefined || message.attachments.length > 0 === query.hasAttachment) &&
        (needle.length === 0 || `${message.subject ?? ""} ${message.snippet ?? ""}`.toLowerCase().includes(needle)),
      );
      const items = matched.slice(offset, offset + pageSize).map(summaryOf);
      const nextOffset = offset + items.length;
      return nextOffset < matched.length
        ? { items, nextCursor: `mem-page:${nextOffset}` }
        : { items };
    },
  };
  return {
    capabilities: { read: true, search: true, pagination: "opaque-cursor" },
    mailboxes,
    reader,
    searcher,
  };
}

function staleOrMissing(ref: MessageRef): MailError {
  return ref.startsWith("stale:")
    ? { code: "STALE_IDENTIFIER", message: "This message reference is stale.", retryable: false, action: "Search again." }
    : { code: "MESSAGE_NOT_FOUND", message: "The selected message was not found.", retryable: false };
}
```

`asMessageRef` and `asMailboxRef` are test-data helpers only. A real provider creates references through its adapter-private codec and validates account scope and staleness before every read or mutation.

## 7. Capability Composition Examples

The capability map describes behavior; the composed object supplies only matching members. A read-only provider does not pretend to support drafts or organization.

```ts
export type AttachmentContent =
  | Readonly<{ kind: "base64"; mediaType: string; filename?: string; value: string }>
  | Readonly<{ kind: "host-handle"; mediaType: string; filename?: string; handle: string }>;
export type ConfirmedMutation<T> = T & Readonly<{ confirm: true }>;
export type MailSender = {
  send(input: ConfirmedMutation<SendMessageInput>): Promise<SendResult>;
  reply(input: ConfirmedMutation<ReplyInput>): Promise<SendResult>;
  forward?(input: ConfirmedMutation<ForwardInput>): Promise<readonly SendResult[]>;
};
export type MailDrafts = {
  createDraft(input: ConfirmedMutation<DraftInput>): Promise<DraftResult>;
  replaceDraft(input: ConfirmedMutation<Readonly<{ draft: MessageRef; value: DraftInput }>>): Promise<DraftResult>;
  sendDraft(input: ConfirmedMutation<Readonly<{ draft: MessageRef }>>): Promise<SendDraftResult>;
};
export type MailOrganizer = {
  archive(input: ConfirmedMutation<Readonly<{ messages: readonly MessageRef[] }>>): Promise<MoveResult>;
  trash(input: ConfirmedMutation<Readonly<{ messages: readonly MessageRef[] }>>): Promise<MoveResult>;
  patchFlags(input: ConfirmedMutation<Readonly<{ messages: readonly MessageRef[]; changes: MessageFlags }>>): Promise<void>;
};
export type MailCapabilities = Readonly<{
  read: true;
  search?: true;
  attachments?: readonly ("base64" | "host-handle")[];
  send?: true;
  replyModes?: readonly ("sender" | "all")[];
  forwardFidelity?: readonly ("native" | "rfc822-attachment" | "text")[];
  drafts?: Readonly<{ replace: true; send: true }>;
  organizer?: Readonly<{ archive?: true; trash?: true; move?: true; flags?: readonly (keyof MessageFlags)[] }>;
  threads?: Readonly<{ rfcHeaders?: true; nativeConversation?: true }>;
  pagination?: "opaque-cursor" | "none";
}>;
export type MailProvider = Readonly<{
  capabilities: MailCapabilities;
  mailboxes: MailboxReader;
  reader: MailReader;
  searcher?: MailSearcher;
  attachments?: Readonly<{ getAttachment(message: MessageRef, attachment: AttachmentRef): Promise<AttachmentContent> }>;
  sender?: MailSender;
  drafts?: MailDrafts;
  organizer?: MailOrganizer;
}>;

const readOnlyCapabilities: MailCapabilities = {
  read: true, search: true, pagination: "opaque-cursor",
};
const writeCapableCapabilities: MailCapabilities = {
  read: true,
  search: true,
  attachments: ["base64"],
  send: true,
  replyModes: ["sender", "all"],
  forwardFidelity: ["rfc822-attachment"],
  drafts: { replace: true, send: true },
  organizer: { archive: true, trash: true, flags: ["seen", "flagged", "answered"] },
  pagination: "opaque-cursor",
};
```

`trash` is intentionally the organizer verb. The v0.1 composition has no `delete`, expunge, or permanently-delete member.

## 8. Mutation Confirmation Boundary

`ConfirmedMutation<T>` expresses a post-validation invariant. Because TypeScript brands do not validate runtime input, every host needs a gate directly before provider invocation.

```ts
export type MailErrorCode =
  | "INVALID_INPUT" | "AUTH_FAILED" | "AUTHORIZATION_REQUIRED"
  | "MESSAGE_NOT_FOUND" | "ATTACHMENT_NOT_FOUND" | "MAILBOX_NOT_FOUND"
  | "STALE_IDENTIFIER" | "CAPABILITY_UNAVAILABLE" | "PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED" | "SEND_FAILED" | "MUTATION_NOT_CONFIRMED" | "CONFLICT";
export type MailError = Readonly<{
  code: MailErrorCode;
  message: string;
  retryable: boolean;
  action?: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}>;

export function assertConfirmedMutation<T>(
  input: T & Readonly<{ confirm?: unknown }>,
): asserts input is ConfirmedMutation<T> {
  if (input.confirm !== true) {
    throw {
      code: "MUTATION_NOT_CONFIRMED",
      message: "This mutation requires confirm: true in the same call.",
      retryable: false,
      action: "Review the exact effect and submit the unchanged request with confirm: true.",
    } satisfies MailError;
  }
}
```

Confirmation is exact-call and exact-payload authorization. It is not cached consent, and changing recipients, content, references, a destination, or a flag patch requires another confirmation.

## 9. Optional Thin MCP Adapter Example

This structural example avoids binding the core to a specific SDK. Schemas are represented as parsers so an integration can use Zod or another validator. Annotation metadata is descriptive only; `assertConfirmedMutation` remains the authorization check.

```ts
export type ToolAnnotations = Readonly<{
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint: boolean;
}>;
export type McpServerLike = {
  registerTool<I>(name: string, definition: {
    annotations: ToolAnnotations;
    parse(input: unknown): I;
    handler(input: I): Promise<unknown>;
  }): void;
};

const readOnly: ToolAnnotations = {
  readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true,
};
const mutation = (destructiveHint: boolean, openWorldHint: boolean): ToolAnnotations => ({
  readOnlyHint: false, destructiveHint, openWorldHint, idempotentHint: false,
});

export function registerMailTools(server: McpServerLike, provider: MailProvider): void {
  server.registerTool("list_mailboxes", {
    annotations: readOnly,
    parse: parseEmptyObject,
    handler: () => provider.mailboxes.listMailboxes(),
  });
  server.registerTool("get_message", {
    annotations: readOnly,
    parse: parseGetMessage,
    handler: (input) => provider.reader.getMessage(input.ref, { body: input.body }),
  });
  if (provider.capabilities.search === true && provider.searcher) {
    server.registerTool("search_mail", {
      annotations: readOnly,
      parse: parseSearchQuery,
      handler: (input) => provider.searcher!.search(input),
    });
  }
  if (provider.capabilities.send === true && provider.sender) {
    server.registerTool("send_mail", {
      annotations: mutation(false, true),
      parse: parseSendInput,
      handler: async (input) => {
        assertConfirmedMutation(input);
        return provider.sender!.send(input);
      },
    });
  }
  if (provider.capabilities.organizer?.trash === true && provider.organizer) {
    server.registerTool("trash_messages", {
      annotations: mutation(true, false),
      parse: parseTrashInput,
      handler: async (input) => {
        assertConfirmedMutation(input);
        return provider.organizer!.trash(input);
      },
    });
  }
}

declare function parseEmptyObject(input: unknown): Record<string, never>;
declare function parseGetMessage(input: unknown): { ref: MessageRef; body?: "none" | "text" | "text-and-html" };
declare function parseSearchQuery(input: unknown): SearchQuery;
declare function parseSendInput(input: unknown): SendMessageInput & { confirm?: unknown };
declare function parseTrashInput(input: unknown): { messages: readonly MessageRef[]; confirm?: unknown };
```

The actual adapter registers equivalent guarded tools for every other declared mutation: reply, forward, create/replace/send draft, archive, move when supported, and flag patches. It registers none when the capability is absent. A host must not infer permission from `readOnlyHint`, `destructiveHint`, `openWorldHint`, or `idempotentHint`.

## 10. Provider Adapter Mapping Examples

These are boundary sketches, not transport implementations.

### iCloud IMAP/SMTP

```ts
type ImapLocator = Readonly<{ mailbox: string; uidValidity: string; uid: number }>;
type ICloudAdapter = Readonly<{
  encodeRef(locator: ImapLocator): MessageRef;      // adapter-private codec
  decodeRef(ref: MessageRef): ImapLocator;
  openReadOnly(mailbox: string): Promise<void>;    // EXAMINE behavior stays here
  capabilities: MailCapabilities;
}>;

const iCloudCapabilities: MailCapabilities = {
  ...writeCapableCapabilities,
  forwardFidelity: ["rfc822-attachment"],
};
```

The adapter keeps its private `mailbox + UIDVALIDITY + UID` locator and public opaque ID codec out of core. Its EXAMINE/read-only workaround is provider-specific. When raw source forwarding is available, it advertises `rfc822-attachment`; this is not a portable forwarding guarantee.

### QQ Mail IMAP/SMTP

```ts
type QQAccountProvider = (accountId: string) => MailProvider;

function resolveQQProvider(accountId: string): MailProvider {
  // account_id belongs to application/adapter selection, not MessageRef parsing.
  return providerForAccount(accountId);
}
declare function providerForAccount(accountId: string): MailProvider;
```

`account_id` remains application/adapter scope. QQ Mail is not claimed conformant by this report. Before conformance it needs runtime `confirm: true` enforcement, read-only read behavior, bounded pagination/body retrieval, verified Trash semantics, and draft cleanup state that distinguishes delivery from cleanup failure.

### Gmail API

```ts
type GmailNativeLocator = Readonly<{ messageId: string; threadId?: string }>;
type GmailAdapter = Readonly<{
  toMessageRef(native: GmailNativeLocator): MessageRef;
  search(query: SearchQuery, internalPageToken?: string): Promise<SearchPage>;
}>;
```

Gmail message IDs, thread IDs, query syntax, and page tokens remain provider-native internally. A core caller sees only opaque references and returns `nextCursor` unchanged.

### Microsoft Graph

```ts
type GraphNativeLocator = Readonly<{ messageId: string; conversationId?: string }>;
type GraphAdapter = Readonly<{
  toMessageRef(native: GraphNativeLocator): MessageRef;
  listFolders(): Promise<readonly Mailbox[]>;
}>;
```

Graph message and conversation IDs remain opaque/provider-native. Graph folders and categories must not be forced into IMAP mailbox or flag semantics; unsupported portable operations are simply absent from its capability map.

## 11. Contract Test Harness Example

The harness is provider-neutral and works without credentials. It observes effects instead of inspecting a private implementation.

```ts
export type ProviderContractFixture = Readonly<{
  provider: MailProvider;
  refs: Readonly<{
    message: MessageRef;
    staleMessage: MessageRef;
    mailbox: MailboxRef;
    trash: MailboxRef;
    draft?: MessageRef;
  }>;
  observe: Readonly<{
    mutationOperations(): number;
    permanentlyDeleted(): readonly MessageRef[];
    externalSends(): readonly Readonly<{ subject: string; recipients: readonly string[] }>[];
  }>;
}>;

export function defineMailProviderContract(makeFixture: () => Promise<ProviderContractFixture>): void {
  describe("mail provider contract", () => {
    it("fails closed for a stale identifier", async () => {
      const { provider, refs } = await makeFixture();
      await expect(provider.reader.getMessage(refs.staleMessage)).rejects.toMatchObject({ code: "STALE_IDENTIFIER" });
    });

    it("returns summaries rather than full bodies from search", async () => {
      const { provider } = await makeFixture();
      if (!provider.searcher) return;
      const page = await provider.searcher.search({ pageSize: 1 });
      expect(page.items[0]).not.toHaveProperty("text");
      expect(page.items[0]).not.toHaveProperty("html");
    });

    it("never calls a mutation provider for an unconfirmed request", async () => {
      const fixture = await makeFixture();
      if (!fixture.provider.sender) return;
      await expect(invokeSendAdapter(fixture.provider, { to: [], subject: "x", text: "x" }))
        .rejects.toMatchObject({ code: "MUTATION_NOT_CONFIRMED" });
      expect(fixture.observe.mutationOperations()).toBe(0);
    });

    it("trashes without permanently deleting", async () => {
      const fixture = await makeFixture();
      if (!fixture.provider.organizer || fixture.provider.capabilities.organizer?.trash !== true) return;
      await fixture.provider.organizer.trash({ messages: [fixture.refs.message], confirm: true });
      expect(fixture.observe.permanentlyDeleted()).toEqual([]);
    });

    it("does not resend after draft cleanup failure", async () => {
      const fixture = await makeFixture();
      if (!fixture.provider.drafts || !fixture.refs.draft) return;
      const result = await fixture.provider.drafts.sendDraft({ draft: fixture.refs.draft, confirm: true });
      expect(result.draftDisposition).toBe("retained-after-send");
      expect(result.warning).toBeDefined();
      expect(fixture.observe.externalSends()).toHaveLength(1);
    });
  });
}

async function invokeSendAdapter(provider: MailProvider, input: SendMessageInput & { confirm?: unknown }): Promise<SendResult> {
  assertConfirmedMutation(input);
  if (!provider.sender) throw { code: "CAPABILITY_UNAVAILABLE", message: "Send is unavailable.", retryable: false } satisfies MailError;
  return provider.sender.send(input);
}

declare function describe(name: string, body: () => void): void;
declare function it(name: string, body: () => Promise<void>): void;
declare function expect(value: unknown): any;
```

The cleanup test fixture deliberately models a successful delivery followed by a failed trash operation. Its correct result is `retained-after-send` with a warning, never another delivery attempt.

## 12. Error Mapping and Redaction Example

Provider errors must be collapsed to a safe public shape at the adapter boundary. The mapper neither forwards raw error text nor serializes a connection, mailbox body, secret, token, or hostname.

```ts
const safeMessages: Record<MailErrorCode, string> = {
  INVALID_INPUT: "The request is invalid.",
  AUTH_FAILED: "Authentication failed.",
  AUTHORIZATION_REQUIRED: "Authorization is required.",
  MESSAGE_NOT_FOUND: "The selected message was not found.",
  ATTACHMENT_NOT_FOUND: "The selected attachment was not found.",
  MAILBOX_NOT_FOUND: "The selected mailbox was not found.",
  STALE_IDENTIFIER: "The selected reference is stale.",
  CAPABILITY_UNAVAILABLE: "This capability is unavailable.",
  PROVIDER_UNAVAILABLE: "The mail provider is temporarily unavailable.",
  RATE_LIMITED: "The provider rate limit was reached.",
  SEND_FAILED: "The message could not be sent.",
  MUTATION_NOT_CONFIRMED: "This mutation requires confirm: true in the same call.",
  CONFLICT: "The requested change conflicts with current mailbox state.",
};

export function mapProviderError(error: unknown, operation: "read" | "send"): MailError {
  const code = providerCode(error, operation);
  return {
    code,
    message: safeMessages[code],
    retryable: code === "PROVIDER_UNAVAILABLE" || code === "RATE_LIMITED",
    action: code === "STALE_IDENTIFIER" ? "Search again before retrying." : undefined,
  };
}

function providerCode(error: unknown, operation: "read" | "send"): MailErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code) : "";
  if (code === "UIDVALIDITY_CHANGED" || code === "MailboxChangedError") return "STALE_IDENTIFIER";
  if (code === "EMAIL_NOT_FOUND" || code === "MessageNotFoundError") return "MESSAGE_NOT_FOUND";
  if (code === "AUTHENTICATION_FAILED") return "AUTH_FAILED";
  return operation === "send" ? "SEND_FAILED" : "PROVIDER_UNAVAILABLE";
}

export function toMailError(error: unknown): MailError {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return error as MailError;
  }
  return mapProviderError(error, "read");
}
```

Only fixed text and explicitly allow-listed details may cross this boundary. Logging policy remains application-specific, but logs should apply the same redaction discipline.

## 13. Security Notes for Untrusted Mail Content

Subjects, addresses, display names, snippets, plain text, HTML, header-derived identifiers, MIME types, filenames, attachment metadata, and attachment bytes are untrusted external data.

- Never treat content inside a message or attachment as a tool instruction, authorization, or configuration.
- Do not execute HTML, scripts, macros, or attachment content; do not auto-fetch remote HTML resources.
- Keep full bodies out of search results and bound selected-body and attachment delivery.
- Validate outgoing Base64, media type, filename, size, and content kind before a send provider is invoked.
- Prefer exact `AttachmentRef` selection; do not make filename guessing the portable path.
- Do not expose a raw local temporary-file path as a portable core result. A provider may use an application-approved opaque handle with explicit lifecycle policy.

## 14. What Must Remain Provider-specific

The core cannot own provider hosts, TLS options, environment variables, credentials, OAuth, MCP hosting, deployment, account selection, IMAP locks, EXAMINE behavior, PEEK behavior, MIME implementation, special-use or localized folder resolution, ID/cursor codecs, or attachment storage.

It also must not normalize Gmail queries, Graph queries, Gmail labels, Graph categories, native conversation identities, service-specific retry behavior, or provider-specific forwarding fidelity. An adapter either maps a capability honestly or omits it.

## 15. Implementation Sequence

1. Create the Zod-free domain types, capability contracts, confirmation assertion, and public error mapper.
2. Add the deterministic in-memory read-only provider and pass mandatory CORE, READ, and SEARCH contract tests.
3. Add the optional MCP adapter and prove that each mutation path rejects omitted or false confirmation before provider invocation.
4. Extend only the test fixture with send/draft/organizer behavior, including cleanup-failure and trash-not-permanent tests.
5. Map iCloud behind an adapter while preserving its existing public behavior and provider-specific read-only handling.
6. Close QQ's documented safety gaps before claiming conformance or enabling a QQ adapter capability map beyond observed behavior.

## 16. Open Questions

1. Should the optional adapter use Zod 4 directly or accept generated JSON Schema so providers do not share a Zod major-version dependency?
2. Which attachment delivery shapes are safe for the target MCP hosts: bounded Base64, host-approved handles, or user-mediated download only?
3. How can QQ Trash and draft cleanup semantics be verified with a mocked or isolated mailbox without risking permanent loss?
4. Which account-scoping mechanism should an application use so references from one selected account are rejected by another provider instance?
5. Which Gmail and Graph features remain explicit provider extensions instead of expanding the portable query, organizer, or thread contracts?

## 17. Proposed Amendments

No amendment to the current v0.1 API specification is proposed by this report. The reference implementation examples exercise the existing decisions: opaque references, capability composition, summary-only search, exact-call confirmation, `trash` rather than `delete`, and explicit draft cleanup outcomes.

If a future implementation requires a change, it should be documented separately with the proposed contract text, rationale, compatibility impact, and alternatives. In particular, adding a permanent-delete capability, a mandatory provider method, a public ID/cursor codec, or a transport/authentication abstraction would be a breaking scope expansion and is not implied by this report.
