# mcp-mail-core v0.1 Provider Contract Test Specification

**Status:** Proposed for review
**Language:** English is normative for test names, fixtures, failure messages, and provider conformance reports.
**Goal:** prove the safety and behavior contract without requiring a live mailbox, provider credentials, or a particular transport.

## 1. Test Harness

The future core repository SHOULD expose a reusable suite:

```ts
export type ProviderContractFixture = {
  provider: MailProvider;
  refs: {
    message: MessageRef;
    staleMessage: MessageRef;
    attachment: AttachmentRef;
    mailbox: MailboxRef;
    trash: MailboxRef;
    draft?: MessageRef;
  };
  observe: {
    readOperations(): number;
    mutationOperations(): number;
    permanentlyDeleted(): readonly MessageRef[];
    externalSends(): readonly { subject: string; recipients: readonly string[] }[];
  };
};

export function defineMailProviderContract(
  makeFixture: () => Promise<ProviderContractFixture>,
): void;
```

Each provider executes the mandatory tests applicable to its advertised capabilities. An absent capability is skipped only when `MailCapabilities` also omits it. A declared capability that cannot pass its mandatory tests is non-conformant.

Tests MUST be deterministic. The default suite MUST use an in-memory fixture or mocked transport. Live integration checks are supplemental, credential-gated, and must not expose content or secrets in logs.

## 2. Mandatory Tests for Every Provider

| ID | Test | Requirement |
|---|---|---|
| CORE-001 | capability/member consistency | Every declared feature has its corresponding interface member; absent features are not declared. |
| CORE-002 | opaque references | The suite treats message, mailbox, attachment, and cursor values as opaque strings and never parses them. |
| CORE-003 | stale reference fails closed | Reading a stale message reference returns `STALE_IDENTIFIER`; it does not return another message. |
| CORE-004 | unknown reference fails safely | A non-existent reference returns `MESSAGE_NOT_FOUND` or `ATTACHMENT_NOT_FOUND` as applicable. |
| CORE-005 | error redaction | Public errors contain no fixture credentials, authorization values, access tokens, raw message body, or host password. |
| CORE-006 | untrusted-content preservation | A message containing instruction-like text is returned as data and causes no tool/provider action. |
| CORE-007 | mailbox shape | Every listed mailbox has an opaque ref, display name, and explicit selectable boolean. |
| CORE-008 | immutable input | The provider does not mutate input objects supplied by the caller. |

## 3. Reader Tests

These tests apply to every provider because `reader` is required.

| ID | Test | Requirement |
|---|---|---|
| READ-001 | selected read | `getMessage` returns the requested message and retains its reference. |
| READ-002 | body projection | `body: "none"` does not return text or HTML; other projections follow the declared choice. |
| READ-003 | bounded body signal | If content is limited, the result sets `body.truncated: true` and reports returned length when known. |
| READ-004 | read-only behavior | A read operation does not change message flags, message placement, or invoke a mutation transport. |
| READ-005 | attachment metadata | Attachment metadata uses an opaque `AttachmentRef`; metadata contains no attachment bytes. |
| READ-006 | address normalization | Missing name/address fields are represented honestly; an invalid synthetic address is not invented. |

For IMAP providers, READ-004 MUST be verified with a mock asserting a read-only/PEEK operation. A live read-only smoke test is recommended after this mocked assertion, not instead of it.

## 4. Search and Pagination Tests

These tests apply only when `capabilities.search === true`.

| ID | Test | Requirement |
|---|---|---|
| SEARCH-001 | summary-only result | Every search item is a `MessageSummary`; no full `text` or `html` field is returned. |
| SEARCH-002 | query narrowing | A supported filter narrows results or returns a documented error; unsupported filters are never silently ignored. |
| SEARCH-003 | page-size bound | The provider respects the documented maximum and rejects/limits an overlarge size predictably. |
| SEARCH-004 | opaque cursor | The fixture passes the returned cursor unchanged; the next page continues without duplicates caused by cursor decoding in the caller. |
| SEARCH-005 | cursor capability match | `nextCursor` is omitted when pagination is `none`; cursor-capable providers advertise `opaque-cursor`. |
| SEARCH-006 | stale cursor | A no-longer-valid cursor fails with a safe public error rather than returning an unrelated result set. |
| SEARCH-007 | snippet bound | Any snippet is bounded by the provider's documented maximum and is treated as untrusted data. |

## 5. Attachment Tests

These tests apply only when `attachments` is declared.

| ID | Test | Requirement |
|---|---|---|
| ATTACH-001 | exact reference selection | Attachment retrieval requires the `AttachmentRef` returned by its parent message; filename guessing is not required by the core path. |
| ATTACH-002 | missing attachment | An unknown attachment returns `ATTACHMENT_NOT_FOUND`. |
| ATTACH-003 | delivery shape | Returned content is one advertised delivery type: bounded Base64 or a host-approved opaque handle. |
| ATTACH-004 | size boundary | A configured oversized attachment is rejected with `INVALID_INPUT`/`CAPABILITY_UNAVAILABLE` before excessive data is exposed. |
| ATTACH-005 | unsafe filename | An unsafe incoming/outgoing filename does not create a path traversal or executable file effect. |
| ATTACH-006 | no remote execution | HTML/CID/attachment data is not executed, rendered with active content, or fetched remotely by the provider. |

## 6. Confirmation Tests

These tests apply to every advertised mutation capability.

| ID | Test | Requirement |
|---|---|---|
| SAFE-001 | omitted confirmation | The adapter rejects an input without `confirm: true` using `MUTATION_NOT_CONFIRMED`; provider mutation count remains zero. |
| SAFE-002 | false confirmation | `confirm: false` is rejected before provider invocation. |
| SAFE-003 | exact-call scope | Approval of one payload does not authorize a changed recipient, changed content, changed reference, changed destination, or changed flag patch. |
| SAFE-004 | annotations are insufficient | A write-like MCP annotation without runtime confirmation does not permit a mutation. |
| SAFE-005 | successful confirmation | A valid exact `confirm: true` reaches the provider once. |

`SAFE-001` through `SAFE-004` are adapter tests. Capability providers MUST additionally test that their public application does not expose a bypass route around the adapter for unconfirmed calls.

## 7. Sender, Reply, and Forward Tests

| ID | Applies when | Test | Requirement |
|---|---|---|---|
| SEND-001 | `send` | recipient validation | Empty/invalid recipient sets fail before send. |
| SEND-002 | `send` | exact side effect | A confirmed send records only the requested recipients and content summary. |
| SEND-003 | `reply` | sender mode | Reply uses the provider's valid reply target and preserves threading when supported. |
| SEND-004 | `replyModes` includes `all` | reply-all mode | Duplicates and the configured self address are excluded; original recipients are not silently broadened beyond contract. |
| SEND-005 | `forward` | declared fidelity | Result behavior matches advertised `text`, `native`, or `rfc822-attachment` fidelity. |
| SEND-006 | any sender | attachment validation | Invalid Base64, unsafe names, unsupported upload tokens, and byte-limit violations fail before delivery. |

## 8. Draft Tests

| ID | Test | Requirement |
|---|---|---|
| DRAFT-001 | create requires confirmation | `createDraft` fails before provider invocation without exact confirmation. |
| DRAFT-002 | replacement is complete | `replaceDraft` creates a complete replacement; omitted body/recipient/attachment fields are not inherited. |
| DRAFT-003 | replacement ID may change | Consumers use `DraftResult.draft`, not the old ID, after replacement. |
| DRAFT-004 | send success cleanup | A successfully sent draft reports `draftDisposition: "trashed"` when cleanup succeeds. |
| DRAFT-005 | cleanup failure is not resendable | A sent draft whose cleanup fails reports `retained-after-send` with a warning; no second send occurs. |
| DRAFT-006 | send failure preserves draft | A delivery failure does not remove/trash the draft. |

## 9. Organizer Tests

| ID | Applies when | Test | Requirement |
|---|---|---|---|
| ORG-001 | `trash` | reversible trash | A confirmed trash operation places a message in the configured Trash role and does not permanently delete it. |
| ORG-002 | `trash` | permanent delete guard | The fixture's `permanentlyDeleted()` remains empty after every v0.1 operation. |
| ORG-003 | `archive` | archive role | Archive fails safely if no provider archive destination exists; it must not guess an unrelated folder. |
| ORG-004 | `move` | remapped reference | If a provider returns a new reference, it is usable; absence is represented as `newRef: undefined`, not a fabricated ID. |
| ORG-005 | `patchFlags` | patch semantics | Only explicitly supplied flag values change; unspecified flag values remain unchanged. |
| ORG-006 | `patchFlags` | idempotency claim | An adapter labels flag patch idempotent only when a repeated identical patch is demonstrably safe. |

## 10. Thread Tests

These tests apply only when `threads` is declared.

| ID | Test | Requirement |
|---|---|
| THREAD-001 | RFC linking | RFC threads link only through Message-ID/In-Reply-To/References evidence. |
| THREAD-002 | subject exclusion | Equal subjects alone do not create a thread edge. |
| THREAD-003 | truncation | A bounded thread result signals truncation. |
| THREAD-004 | native distinction | A native Gmail/Graph conversation returns `kind: "native"`; a reconstructed RFC result returns `kind: "rfc"`. |

## 11. Provider-Specific Conformance Matrix

This is the expected starting status, not a release certification.

| Requirement group | iCloud Mail MCP | QQ Mail MCP | Required action before core conformance |
|---|---|---|---|
| CORE / READ | Expected pass: opaque UIDVALIDITY IDs, bounded read path, EXAMINE/PEEK tests | Partial: IDs/errors exist, but reads currently open writable mailbox | QQ: add/read-test read-only mailbox operations. |
| SEARCH | Expected pass: summary-first search and opaque cursor | Partial: summaries exist but no cursor and source parsing is unbounded | QQ: advertise `none` or add opaque pagination; bound preview/body work. |
| ATTACH | Partial: exact part and size cap, Base64 delivery | Partial: attachment ID available, but filename fallback and temp path delivery | Define safe host-handle lifecycle; make exact attachment ref the normal path. |
| SAFE | Expected pass: Zod requires same-call `confirm:true` | Fail: descriptions/annotations request approval but no runtime field | QQ: mandatory `confirm:true` adapter validation. |
| SEND / DRAFT | Expected pass for major behavior; contract fixture required | Partial: send/draft flow exists; cleanup uses `messageDelete` | QQ: prove no permanent deletion and add cleanup state. |
| ORGANIZER | Expected pass for trash/archive/flags; contract fixture required | Partial: move-to-special-use exists, but delete semantics must be live/mocked verified | QQ: prove Trash semantics and flag patch behavior. |
| THREAD | Expected pass as bounded RFC reconstruction | Partial: RFC reconstruction is tested but limited to last 1,000 messages in one mailbox | Advertise explicit search scope/truncation. |

## 12. Release Gate

`@mcp-mail/core` v0.1 MUST NOT be published until:

1. An in-memory reference provider passes all applicable mandatory tests.
2. The optional MCP adapter passes `SAFE-001` to `SAFE-005`.
3. Each claimed reference provider publishes its completed conformance matrix, including skipped groups and live-test boundaries.
4. iCloud and QQ write-capability conformance is not claimed until their respective safety gaps are closed.
5. Package README, API specification, test report, and migration notes are in English.

## 13. Recommended Implementation Order

1. Define the domain values, error type, capability types, and in-memory read-only provider.
2. Implement the contract harness and make the reference provider pass CORE/READ/SEARCH tests.
3. Implement the thin MCP adapter and confirmation tests before any mutation adapter is registered.
4. Add sender/draft/organizer fixture behaviors and their tests.
5. Map iCloud as the first real provider adapter without changing its public behavior.
6. Close QQ safety and semantic gaps, then map it as the second adapter.
