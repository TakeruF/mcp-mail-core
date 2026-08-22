# Multi-account, multi-provider mail core architecture

Status: executable Gmail slice implemented; QQ/iCloud migration gated. Research checked on 2026-08-22.

## 1. Existing-system findings

The findings below come from the checked-out implementations, not provider assumptions.

### QQ Mail MCP

- Authentication is QQ Mail email plus authorization code over IMAP/SMTP. `QQMAIL_ACCOUNTS` already maps logical account IDs to independent credentials; the older single-account variables remain a fallback.
- Public IDs encode provider prefix, mailbox, UIDVALIDITY, and UID. Threads are reconstructed from `Message-ID`, `In-Reply-To`, and `References`, not subject similarity.
- Search translates portable fields into IMAP SEARCH, but then fetches full message source to create previews. It has no cursor and opens mailboxes writable even for reads.
- Folders are IMAP mailboxes with special-use detection and Chinese/English fallback names. There is no Gmail-style many-to-many label model.
- It implements attachments, SMTP send/reply/forward, IMAP drafts, archive, Trash (named `deleteEmails`), and read/unread. Forward currently quotes text and does not preserve original attachments.
- Mutation descriptions ask for confirmation, but schemas and provider methods do not require literal `confirm: true` at runtime. This is the largest safety gap.
- Draft replace creates the replacement and then deletes the original; send-draft sends and then deletes it, but the result does not distinguish “sent but cleanup failed.”
- Errors are structured, but unexpected IMAP messages can be exposed too directly. Attachment filename fallback is less unambiguous than attachment ID.

### iCloud Mail MCP

- Authentication is one configured iCloud email plus app-specific password for IMAP/SMTP. Its HTTP deployment OAuth protects the MCP endpoint; it is not iCloud mailbox OAuth and must not be abstracted as such.
- IDs and cursors include mailbox and UIDVALIDITY. Reads use read-only mailbox locks and PEEK behavior. Search previews, bodies, batches, raw messages, threads, and attachments have explicit bounds.
- Search is IMAP-filter based with one mailbox per query and an opaque cursor bound to filters and UIDVALIDITY.
- Threads are bounded RFC-header discovery across selectable mailboxes. There are no native provider thread IDs or labels.
- It implements attachment reads, SMTP send/reply/forward, drafts, folder creation, move/archive/Trash, and Seen/Flagged/Answered changes. Forward preserves the original as `message/rfc822`.
- Every mutation schema requires literal `confirm: true`. Trash rejects messages already in Trash; expunge and permanent delete are absent.
- Draft replacement saves first, then moves the old draft to Trash. Send-draft reports the important partial outcome “sent, cleanup failed; do not resend.”
- Remote deployment validates HTTPS, authentication, host/origin, body limits, timeouts, and rate limits.

### Silkroad MCP

Silkroad explicitly treats mail-core as an evaluation boundary, not a runtime dependency. Its guidance agrees that stable IDs, bounded non-mutating reads, exact confirmation, and Trash are shareable, while IMAP/SMTP settings, provider authentication, OAuth, deployment, MIME implementation, and folder conventions remain adapter-owned.

## 2. Gmail API and OAuth findings

The Gmail adapter uses the official API because it provides materially better native semantics than Gmail IMAP.

- Gmail exposes messages, native threads, labels, drafts, attachments, history, and provider-native search. `messages.list` and `threads.list` return opaque `nextPageToken` values.
- Gmail labels are many-to-many and live on messages. Thread label views are an aggregation, and applying a label to a thread affects existing messages, not future messages. They are not folders.
- Archive is removal of the `INBOX` label. Trash has dedicated methods. `messages.delete` and `threads.delete` permanently delete immediately and are deliberately not exposed.
- Replies that should join a Gmail thread need the native `threadId`, RFC-compliant `References` and `In-Reply-To`, and a matching subject. The adapter preserves all three.
- Gmail API search accepts most Gmail advanced syntax, but unlike the UI it does not expand account aliases and does not provide UI-style thread-wide search. Query dates default to PST midnight unless epoch seconds are used. The core therefore labels `nativeQuery` as provider-native rather than portable.
- `getProfile` discovers the authorized Gmail address. Local account ID remains independent (`gmail-university` is stable even if a display label changes).
- The default scope is `gmail.modify`: it covers read, compose, send, label mutation, archive, and Trash while excluding immediate permanent deletion. It is a restricted scope. A public or remote product may require OAuth verification and, when restricted-scope data is stored or transmitted, a security assessment.
- Desktop enrollment uses a loopback redirect, PKCE, random `state`, offline access, and consent. Manual copy/paste/OOB is not used. Each enrollment has a separate credential handle and refresh token.
- Refreshes are account-scoped and coalesced per credential. A refresh response without a new refresh token preserves the prior one. `invalid_grant` marks reauthorization as required rather than retrying indefinitely.
- External OAuth apps in Testing generally receive refresh tokens that expire after seven days when Gmail scopes are requested. This is unsuitable for persistent operation.
- Revocation uses Google's revocation endpoint. Google documents that revocation removes all scopes granted to the project and can invalidate related tokens, so remote multi-user removal needs careful product policy.
- Current Gmail API quota documentation lists 1,200,000 quota units per minute per project, 6,000 per minute per user per project, and an 80,000,000 daily project threshold for projects under the post-2026-05-01 model. Methods have different costs (for example list 5, get 20, send 100). The adapter applies bounded `Retry-After`/exponential backoff only to idempotent GET requests. It deliberately does not automatically retry sends or mutations whose outcome may be ambiguous.

Primary sources: [Gmail API reference](https://developers.google.com/workspace/gmail/api/reference/rest), [OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [desktop OAuth and revocation](https://developers.google.com/identity/protocols/oauth2/native-app), [server-side/offline OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [search differences](https://developers.google.com/workspace/gmail/api/guides/filtering), [threads](https://developers.google.com/workspace/gmail/api/guides/threads), [labels](https://developers.google.com/workspace/gmail/api/guides/labels), [sending](https://developers.google.com/workspace/gmail/api/guides/sending), and [quota](https://developers.google.com/workspace/gmail/api/reference/quota).

## 3. Capability matrix

Legend: common = safe common contract; semantic = common operation with documented provider semantics; extension = provider-specific capability; gate = implemented in provider repo but not safe/core-conformant yet; unsupported = absent.

| Capability | Gmail API adapter | QQ Mail current | iCloud Mail current | Classification |
|---|---|---|---|---|
| Search | Gmail `q` + metadata fetch | IMAP SEARCH + full-source preview | bounded IMAP SEARCH + PEEK preview | common, semantics differ |
| Provider-native search | full Gmail syntax | no | no | Gmail extension |
| Pagination | `nextPageToken` | none | opaque filter-bound cursor | common; QQ gate |
| Native threads | yes, `threadId` | no | no | Gmail extension |
| RFC-header threads | headers available | reconstructed | bounded cross-mailbox discovery | semantic capability |
| Labels | native many-to-many | no | no | Gmail extension |
| Folders/mailboxes | no folder abstraction | IMAP | IMAP | IMAP provider capability |
| Attachments | native part/attachment IDs | parser index; filename fallback | MIME part IDs, 5 MiB bound | common; QQ gate |
| Drafts | native create/update/send | IMAP Drafts | IMAP Drafts | common, cleanup differs |
| Send | Gmail API MIME | SMTP | SMTP | common, transport private |
| Reply | native thread + RFC headers | RFC headers | RFC headers/reply-all | common, semantics differ |
| Forward | original `message/rfc822` | quoted body, drops originals | original `message/rfc822` | common but QQ remains below baseline |
| Archive | remove `INBOX` | move to Archive mailbox | move to special-use Archive | semantic common operation |
| Trash | native Trash endpoint | move to detected Trash | move to special-use Trash; reject already there | common; rename QQ delete |
| Permanent delete | API supports, adapter refuses | not exposed intentionally | not exposed intentionally | unsafe to abstract; excluded |
| Read/unread | `UNREAD` label | `\\Seen` | `\\Seen` | semantic common flag |
| Star/flag | `STARRED` | unsupported | `\\Flagged` | semantic optional flag |
| Answered flag | no equivalent exposed | unsupported | `\\Answered` | IMAP extension |
| OAuth to mailbox | OAuth 2.0 | no | no | Gmail-specific auth |
| IMAP/SMTP | deliberately no | yes/yes | yes/yes | adapter-private transport |
| Multi-account | implemented registry + isolated OAuth | environment mapping exists | single account | core common; migration varies |
| Literal runtime confirmation | core + MCP schema | absent | present | mandatory baseline; QQ gate |
| Read-only bounded reads | bounded API reads | absent/incomplete | present | mandatory baseline; QQ gate |
| Partial “sent but cleanup failed” | native draft send is atomic API operation | not reported | explicitly reported | mandatory where multi-step |
| Rate/deployment controls | API errors mapped; local stdio | deployment-specific | mature HTTP controls | deployment-specific |

The baseline follows the better existing behavior: iCloud's bounded/read-only/confirmed/partial-outcome safety, QQ's existing account selection and header threading, and Gmail's native labels, threads, search, and drafts.

## 4. Architecture and exact shared abstraction

```text
ChatGPT / MCP client
        |
  bounded MCP tools + confirmation gate
        |
  MultiAccountMailService
   | account registry (non-secret metadata)
   | cross-account fan-out / per-account cursor / partial failures
   | account-scoped MessageRef, ThreadRef, DraftRef, AttachmentRef
        |
  provider adapter selected per account
   | Gmail API adapter       | future QQ adapter       | future iCloud adapter
        |                    |                         |
  credential handle         QQ auth-code store         iCloud app-password store
        |
  macOS Keychain (local Gmail refresh tokens)
```

The shared layer is deliberately small:

- `MailAccount`: stable ID, provider ID, human label, routing roles, capability declaration, health status, and provider identity. The public shape excludes `credentialId`.
- `AccountRegistry`: list/get/add/update/remove non-secret metadata. Multiple accounts may reference the same adapter but never the same credential record by accident.
- Account-scoped references: `{accountId,messageId}`, `{accountId,threadId}`, `{accountId,draftId}`, and `{accountId,messageId,attachmentId}`. Provider IDs remain opaque.
- `MailProviderAdapter`: health, search, selected read, and optional capability methods. Authentication and transport are passed only as an opaque credential handle in internal context.
- `MultiAccountMailService`: read fan-out, provenance qualification, capability enforcement, explicit write routing, runtime confirmation, and fail-closed errors.

Not shared: token formats, IMAP/SMTP/OAuth implementations, MIME parsers, Gmail label codecs, IMAP mailbox detection, provider cursor internals, HTTP deployment auth, or provider branding.

## 5. Cross-account read semantics

Reads default to all accounts whose registry status is `ready`; this matches agent requests such as “find OpenAI across all my mail.” Explicit `accounts` narrows the request.

Each returned page is grouped by account and contains at most `limitPerAccount` results. The aggregate cursor stores one opaque provider cursor per account, is fingerprint-bound to a canonicalized account selection/query/page size, and is authenticated with HMAC-SHA256. The local host persists a random owner-only signing key so cursors survive restarts and tampering fails closed. This design can return up to accounts × limit results, but it does not silently discard lower-ranked results after advancing a provider cursor. A global top-N merge without buffered leftovers was rejected because it can skip messages.

Failures are returned as `{accountId,code,message,retryable}` beside successful pages. A failed account's position is retained for retry instead of advancing silently. Cross-provider order is not claimed to be globally stable because provider timestamp and search relevance semantics differ.

## 6. Write and security model

- There is no default sending account. `accountId` or an account-scoped target is mandatory.
- Literal `confirm: true` is enforced by the MCP schema and again in the service at runtime. Tool annotations are advisory only.
- Reply and forward use the selected message's account. A reply-to draft cannot cross account boundaries.
- Search returns summaries; bodies and attachments require selected reads. Gmail bodies are bounded to 20,000 characters in v0.2.
- Archive and Trash are named separately. Permanent delete has no service method, MCP tool, or Gmail adapter method. The broad `mail.google.com` scope is not requested.
- Gmail tokens are stored as separate Keychain generic-password items keyed by an opaque credential handle. Account metadata is atomically written with mode `0600`; its directory is mode `0700`.
- OAuth callback uses loopback, PKCE, and state. Tokens and client secrets are ignored by Git.
- Provider errors redact bodies and tokens. Unknown errors become a generic public failure.
- Message bodies and attachments are untrusted content; MCP instructions explicitly prohibit treating them as commands.

For remote deployment, local Keychain and stdio assumptions no longer apply. Use an encrypted multi-tenant secret manager, bind every account to an authenticated MCP principal, validate HTTPS/issuer/audience/origin/host, add audit logs without content or tokens, rate limiting, CSRF/state/session protection for enrollment, data retention policy, OAuth verification, and a restricted-scope security assessment where required. Do not expose the local enrollment callback or account registry as a public admin API.

## 7. MCP tool surface

The executable server exposes fourteen cohesive tools: account discovery; cross-account search; selected message/thread/attachment reads; send; create/update/send draft; reply; forward; archive; Trash; and flags. Provider details stay behind capability discovery. `nativeQuery` is the one intentional provider-power escape hatch in common search.

Provider-specific tools should be added only when semantics cannot fit a capability-aware common operation. Gmail label creation/deletion and history/watch are not in v0.2. Native label IDs are preserved on results, but label administration is postponed.

## 8. Alternatives considered and rejected

- **Gmail over IMAP/SMTP:** rejected because it loses native thread IDs, labels, drafts, search, and clearer Trash/archive operations.
- **One global Gmail token:** rejected because enrollment of a second account could replace the first and provenance becomes unsafe.
- **Universal folder/label model:** rejected because Gmail labels are many-to-many while IMAP messages reside in mailboxes.
- **One mandatory mega-provider interface:** rejected because unsupported stubs obscure capabilities and encourage false equivalence.
- **Global search ranking and one total limit:** rejected for v0.2 because provider relevance is incomparable and naïve cursor advancement can drop results.
- **Generic `delete`:** rejected because it conflates Trash with irreversible deletion.
- **Immediate QQ/iCloud dependency migration:** rejected because QQ currently fails mandatory safety/bounds gates and iCloud's mature deployment/auth behavior should not be destabilized by a new core.
- **Credentials inside the account JSON:** rejected because metadata routing and authentication secrets have different exposure and lifecycle requirements.

## 9. Migration strategy

1. Keep QQ and iCloud production servers independent. Consume this package only in synthetic adapter tests first.
2. Build an iCloud adapter mapping existing bounded `MailService`/`MailSender` operations. Preserve its IDs/cursors, read-only locks, limits, exact confirmation, draft partial outcomes, and remote security. Do not move IMAP/SMTP or endpoint OAuth into core.
3. Harden QQ before conformance: use read-only mailbox opens and PEEK, metadata-only bounded search, opaque pagination, bounded bodies/attachments, attachment-ID-only selection, literal runtime confirmation, explicit `trash` naming, safe draft partial outcomes, and redacted unexpected errors.
4. Run the same provider contract suite against Gmail, iCloud, and QQ adapters. Capability-specific tests may skip only declared unsupported features.
5. Host adapters in one unified MCP server only after account credential stores and deployment principal-to-account authorization are defined for each provider. Existing provider-specific servers remain rollback paths.
6. Once stable, provider repositories may depend on domain/contracts and shared contract tests. They should not depend on Gmail OAuth, another provider's codec, or one common transport implementation.

## 10. Implemented tests and remaining limitations

Automated mocked tests cover independent credentials, overwrite rejection, selected/all-account search, account provenance, provider-ID collision, partial provider failure, per-account pagination, explicit source account, runtime confirmation, unsupported capability failure, Gmail native query/labels/thread IDs, body and attachment parsing, native thread read, draft create/update/send, threaded reply, archive/Trash/flags, PKCE, token refresh isolation, and revoked credentials.

Remaining limitations:

- QQ and iCloud adapters are not implemented in this repository and their production servers were not changed.
- Gmail address parsing handles quoted commas, Reply-To, case-insensitive deduplication, and reply-all self-exclusion, but it is not a complete RFC 5322 parser and should be replaced by a hardened parser before broad deployment.
- The Gmail adapter limits per-page metadata fetches to eight concurrent requests and retries idempotent reads at most three times. It does not yet coordinate a global per-account quota budget across concurrent searches.
- Account health is modeled and adapter health exists, but the CLI does not persist health refresh results automatically.
- The server is local stdio only. Remote MCP auth and multi-tenant authorization are deliberately absent.
- No live credential test was run in this work. The opt-in profile/metadata smoke test is isolated under `tests/live/` and normal tests exclude it.
- Removal/revocation is deliberately an explicit-confirmation administrative CLI operation rather than an MCP mail tool.

## 11. Recommended next steps

1. Add a shared per-account quota budget and observability for concurrent searches.
2. Add opt-in Gmail live smoke tests using a dedicated test account and metadata-only fixtures.
3. Implement the iCloud adapter first; it is closest to the target safety contract.
4. Harden QQ to the listed gates, then implement its adapter.
5. Replace the bounded built-in address parser with a fully RFC-tested parser before broad remote deployment.
6. Only then evaluate one remote unified MCP deployment, with principal-to-account authorization and a production secret manager designed first.
