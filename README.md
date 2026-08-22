# mcp-mail-core

`mcp-mail-core` is a safety-first, multi-account mail MCP server and provider adapter library. The executable v0.2 slice supports multiple independently authorized Gmail accounts through the official Gmail API. QQ Mail and iCloud Mail remain separate implementations until they pass the shared contract and safety gates described in the architecture report.

## What is implemented

- Stable account IDs independent of provider identity and credential identity.
- Cross-account reads, all-ready-account default, explicit account selection, per-account pagination, result provenance, ID collision prevention, and visible partial failures.
- A Gmail API adapter with native search, native threads, labels, attachments, drafts, send/reply/forward, archive, Trash, unread, and starred operations.
- Independent OAuth credentials per Gmail account, refresh-token rotation, revoked-token handling, PKCE, account identity discovery, and programmatic revocation support.
- macOS Keychain token storage and a `0600` JSON registry containing metadata only.
- A stdio MCP server with bounded schemas. Every write requires an explicit account or account-scoped reference and literal `confirm: true` in the same call.
- No permanent-delete tool or adapter capability.

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

The default metadata path is `~/Library/Application Support/mcp-mail-core/accounts.json`. It contains labels, roles, capabilities, status, provider identity, and opaque Keychain credential handles—not OAuth tokens. Override its directory with `MCP_MAIL_CORE_DATA_DIR`.

## Tool behavior

Reads (`list_mail_accounts`, `search_mail`, `get_message`, `get_thread`, and `get_attachment`) are non-mutating. `search_mail` defaults to every ready account; pass `accounts` for a narrower query. Results are grouped into account pages so advancing one provider cursor never drops an unreturned result from another account.

Writes (`send_mail`, drafts, reply, forward, archive, Trash, and flags) never default the account. Each requires `confirm: true`. Replies use the source message's account. `trash_mail` is recoverable provider Trash, not permanent deletion.

`nativeQuery` preserves Gmail search power. It is intentionally not described as portable to IMAP providers.

## Development

```sh
npm run typecheck
npm test
npm run build
```

Normal tests use synthetic data and mocked HTTP. The opt-in live smoke test is isolated under `tests/live/` and requires all of `MCP_MAIL_RUN_LIVE=true`, `GOOGLE_OAUTH_CLIENT_ID`, and a Keychain handle in `MCP_MAIL_LIVE_CREDENTIAL_ID`.

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
