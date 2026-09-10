# Gmail live smoke test runbook

The opt-in live smoke test in `tests/live/gmail.test.ts` is the only test that talks to a real
Google account. Run it before publishing a release that is meant for real deployment, then record
the result in the release notes.

## What it does

The test is strictly read-only. It performs exactly three Gmail API calls:

| Call | Scope of access |
| --- | --- |
| `GmailApi.profile()` | reads the authorized address |
| `GmailApi.listMessages({ maxResults: 1 })` | reads at most one message id |
| `GmailApi.getMessage(id, "metadata")` | reads headers only, never the body |

It sends nothing, drafts nothing, labels nothing, and deletes nothing. A dedicated low-value
account is still preferable to a primary mailbox.

## Prerequisites

- macOS. Credentials are read through `MacOsKeychainGmailCredentialStore`, which shells out to
  `security find-generic-password`. There is no other credential store.
- A Google OAuth **desktop** client id. The enrollment flow binds to a loopback redirect on an
  ephemeral port (`http://127.0.0.1:<port>/oauth/callback`), which only the desktop client type
  allows.
- An account already enrolled in this checkout's registry.

## 1. Enroll a read-only account

Skip this if `npm run accounts:list` already returns the account you want to use.

```sh
npm run build
GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
MCP_MAIL_ACCOUNT_ID='gmail-livetest' \
npm run enroll:gmail
```

The command opens the Google consent screen and stores the refresh token in the login Keychain
under service `mcp-mail-core.gmail`. Enrollment aborts after five minutes.

## 2. Resolve the credential id

The credential id is **not** the account id, and `npm run accounts:list` deliberately strips it
(`publicAccount` removes `credentialId`). It is always the account id with a provider prefix:

```
credentialId = "gmail:" + accountId
```

So `MCP_MAIL_ACCOUNT_ID='gmail-livetest'` yields `gmail:gmail-livetest`. Confirm the Keychain item
exists without printing the secret:

```sh
security find-generic-password -s mcp-mail-core.gmail -a 'gmail:gmail-livetest' >/dev/null && echo present
```

## 3. Run the test

All three variables are required. `MCP_MAIL_RUN_LIVE` must be the exact string `true`; anything
else silently skips the suite rather than failing.

```sh
GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
MCP_MAIL_LIVE_CREDENTIAL_ID='gmail:gmail-livetest' \
MCP_MAIL_RUN_LIVE=true \
npm run test:live
```

A real run reports `1 passed`. If it reports `1 skipped`, one of the three variables is missing or
`MCP_MAIL_RUN_LIVE` is not exactly `true` — treat a skip as "not verified", never as a pass.

## 4. Clean up

If the account was enrolled only for this test, remove it and revoke the grant:

```sh
GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
MCP_MAIL_ACCOUNT_ID='gmail-livetest' \
MCP_MAIL_CONFIRM_REMOVE=true \
npm run remove:gmail
```

Revocation applies to the OAuth project's grant for that account, so it can invalidate tokens for
other accounts enrolled under the same client id. If other accounts share the client id, keep the
test account instead of revoking.

## Not covered here

Core never holds QQ authorization codes or iCloud app-specific passwords, so QQ and iCloud live
checks belong to their own provider repositories and are not exercised by this runbook.
