# mcp-mail-core

`mcp-mail-core` is a safety-first, multi-account mail MCP server and provider adapter library. The executable v0.3 slice supports multiple independently authorized Gmail accounts through the official Gmail API and provides the versioned contract used by the sibling QQ Mail and iCloud Mail adapters. Their v0.2 integrations completed provider-repository validation and rollout; they must adopt the v0.3 draft-disposition result types before repinning to this release.

## What is implemented

- Stable account IDs independent of provider identity and credential identity.
- Cross-account reads, all-ready-account default, explicit account selection, per-account pagination, result provenance, ID collision prevention, and visible partial failures.
- A Gmail API adapter with native search, native threads, labels, attachments, drafts, send/reply/forward, archive, Trash, unread, and starred operations.
- Independent OAuth credentials per Gmail account, refresh-token rotation, revoked-token handling, PKCE, account identity discovery, and programmatic revocation support.
- macOS Keychain token storage and a `0600` JSON registry containing metadata only.
- A stdio MCP server with bounded schemas. Every write requires an explicit account or account-scoped reference and literal `confirm: true` in the same call.
- No permanent-delete tool or adapter capability.
- Bulk Archive, Trash, and flag mutations are restricted to one account per call, preventing ambiguous cross-account partial writes.
- Draft replacement and sending return an explicit cleanup disposition. A retained post-send draft is reported as already sent with a warning and must never be interpreted as permission to resend.
- Host construction validates each adapter's advertised capabilities against its implemented methods before any account or remote mailbox operation runs.
- `createMailHost` composes independently configured provider adapters without moving provider credentials, transport, or MIME behavior into Core.

See [the architecture and provider study](docs/multi-account-mail-core-architecture.md) for evidence, the capability matrix, security decisions, migration stages, and limitations.

## Local Gmail setup on macOS

1. In Google Cloud, enable the Gmail API, configure the OAuth consent screen, and create a **Desktop app** OAuth client.
2. Keep the OAuth app in Testing only for short-lived development. Google documents a seven-day refresh-token lifetime for external Testing apps requesting Gmail scopes; configure the publishing status appropriately for persistent private use.
3. Build the project:

   ```sh
   npm install
   npm run build
   ```

4. Enroll the first account. The command opens Google authorization through a loopback callback with PKCE. Choose the intended Google account in the browser.

   ```sh
   GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
   MCP_MAIL_ACCOUNT_ID='gmail-personal' \
   MCP_MAIL_ACCOUNT_LABEL='Personal Gmail' \
   MCP_MAIL_ACCOUNT_ROLES='personal' \
   npm run enroll:gmail
   ```

5. Enroll another account with a different stable ID. This creates another Keychain item and cannot overwrite the first account.

   ```sh
   GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
   MCP_MAIL_ACCOUNT_ID='gmail-university' \
   MCP_MAIL_ACCOUNT_LABEL='University Gmail' \
   MCP_MAIL_ACCOUNT_ROLES='university' \
   npm run enroll:gmail
   ```

6. Configure the MCP client to run `npm start` from this repository with `GOOGLE_OAUTH_CLIENT_ID` in its environment. Standard output is reserved for MCP traffic.

List configured accounts without exposing credential handles or tokens:

```sh
npm run accounts:list
```

Refresh account identity and authorization health, persisting only the safe status in the registry:

```sh
GOOGLE_OAUTH_CLIENT_ID='your-client-id' npm run accounts:check
```

Set `MCP_MAIL_ACCOUNT_ID` to check only one account. A revoked or expired grant becomes `reauthorization_required`; tokens and provider error bodies are not printed.

The default metadata path is `~/Library/Application Support/mcp-mail-core/accounts.json`. It contains labels, roles, capabilities, status, provider identity, and opaque Keychain credential handles—not OAuth tokens. The same owner-only directory contains `cursor.key`, a random HMAC key used to authenticate cross-account pagination state across restarts. Override the directory with `MCP_MAIL_CORE_DATA_DIR`.

## QQ and iCloud adapters

The sibling QQ repository exports `QQMailCoreAdapter`; the iCloud repository exports `ICloudMailCoreAdapter`, secret-free account metadata, an injected credential-store contract, and a local macOS Keychain implementation. Their IMAP, SMTP, MIME, identifier, cursor, credential, and remote OAuth behavior remains provider-owned. Core owns account provenance, fan-out, confirmation, capability checks, aggregate cursor authentication, and provider-neutral MCP tools.

See the [QQ integration guide](https://github.com/TakeruF/qq-mail-mcp/blob/agent/qq-mail-mcp/docs/mcp-mail-core-adapter.md), the [iCloud integration guide](https://github.com/TakeruF/icloud-mail-mcp/blob/main/docs/mcp-mail-core-integration.md), and the [v0.3 migration guide](docs/v0.3-migration.md). The provider repositories currently pin the stable v0.2 artifact; v0.3 adoption is an explicit migration rather than an implicit contract change.

## Package artifact

`npm pack` now produces a bounded artifact containing compiled runtime, declarations, and this README—not source, tests, or local credentials. `npm run test:package` installs that artifact in a fresh temporary consumer and verifies runtime and TypeScript imports. Every CI run uploads the tarball and `SHA256SUMS` as a commit-scoped GitHub Actions artifact.

The package remains `private: true`: CI artifacts are integration inputs, not a claim that an npm release or license decision has been completed. Do not publish it to a public registry until repository licensing and release ownership are explicitly settled.

## Tool behavior

Reads (`list_mail_accounts`, `search_mail`, `get_message`, `get_thread`, and `get_attachment`) are non-mutating. `search_mail` defaults to every ready account; pass `accounts` for a narrower query. Results are grouped into account pages so advancing one provider cursor never drops an unreturned result from another account.

Writes (`send_mail`, drafts, reply, forward, archive, Trash, and flags) never default the account. Each requires `confirm: true`. Replies use the source message's account. `trash_mail` is recoverable provider Trash, not permanent deletion.

`nativeQuery` preserves Gmail search power. It is intentionally not described as portable to IMAP providers.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run test:package
```

Normal tests use synthetic data and mocked HTTP. The opt-in Gmail live smoke test is isolated under `tests/live/` and requires all of `MCP_MAIL_RUN_LIVE=true`, `GOOGLE_OAUTH_CLIENT_ID`, and a Keychain handle in `MCP_MAIL_LIVE_CREDENTIAL_ID`. Provider-repository live checks remain separate because Core never owns QQ authorization codes or iCloud app-specific passwords.

## Removing an account

Removal is an administrative CLI operation, not an MCP mail tool. It requires confirmation in the same command, requests Google token revocation, removes the Keychain item, and then removes account metadata:

```sh
GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
MCP_MAIL_ACCOUNT_ID='gmail-personal' \
MCP_MAIL_CONFIRM_REMOVE=true \
npm run remove:gmail
```

For an exceptional local cleanup where the Google grant must be preserved, add `MCP_MAIL_SKIP_REVOCATION=true`. This still removes the local Keychain item and registry record.

If revocation fails, metadata is preserved rather than claiming removal. Google notes that revocation affects the project's grant and may invalidate tokens more broadly than one local account record; review the architecture report before using it in a shared remote deployment.
