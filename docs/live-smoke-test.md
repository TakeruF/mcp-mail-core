# Gmail live smoke test runbook

The opt-in live smoke test in `tests/live/gmail.test.ts` is the only test that talks to a real
Google account. Run it before publishing a release that is meant for real deployment, then record
the result in the release notes.

## What it does

The test issues no writes — it sends nothing, drafts nothing, labels nothing, and deletes nothing.
It makes up to three Gmail API calls, all reads:

| Call | What it reads |
| --- | --- |
| `GmailApi.profile()` | the authorized address |
| `GmailApi.listMessages({ maxResults: 1 })` | at most one message id |
| `GmailApi.getMessage(id, "metadata")` | that message's headers, `snippet`, `labelIds`, `internalDate`, and MIME part tree — filenames, attachment ids, and sizes |

Two caveats that "no writes" does not cover:

- **`"metadata"` is not Gmail's `format=metadata`.** `GmailApi.getMessage` maps it to `format=full`
  with a `fields` projection (`src/gmail/api.ts`). That omits `body.data`, so no message body is
  transferred, but `snippet` is a Gmail-generated excerpt of the body, and attachment filenames are
  returned. Pick the account accordingly.
- **The credential is not read-only.** See the scope note in step 1.

## Prerequisites

- macOS. Credentials are read through `MacOsKeychainGmailCredentialStore`, which shells out to
  `security find-generic-password`. There is no other credential store.
- A Google OAuth **desktop** client id. The enrollment flow binds to a loopback redirect on an
  ephemeral port (`http://127.0.0.1:<port>/oauth/callback`), which only the desktop client type
  allows.
- An account already enrolled in this checkout's registry.
- **A mailbox with at least one message.** On an empty mailbox the test still reports `1 passed`
  while having exercised only two of the three calls — `tests/live/gmail.test.ts` guards the
  `getMessage` assertion behind `if (page.messages?.[0])`. A freshly created throwaway account is
  exactly the case that hits this, so send it one message before treating a pass as verification of
  the metadata path.

## 1. Enroll a dedicated test account

Skip this if `npm run accounts:list` already returns the account you want to use.

```sh
npm run build
GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
MCP_MAIL_ACCOUNT_ID='gmail-livetest' \
npm run enroll:gmail
```

The command opens the Google consent screen and stores the refresh token in the login Keychain
under service `mcp-mail-core.gmail`. Enrollment aborts after five minutes.

**The granted scope is `https://www.googleapis.com/auth/gmail.modify`, not a read-only scope.**
`enroll:gmail` does not pass a scope, so `createDesktopAuthorization` uses `GMAIL_DEFAULT_SCOPES`
(`src/gmail/oauth.ts`), which is the narrowest single scope covering the whole adapter — reads,
drafts, sends, label changes, archive, and Trash. It excludes only permanent delete. The smoke test
never exercises any of that, but the credential sitting in your Keychain can, so authorize a
throwaway mailbox rather than one you care about.

Enrollment also requests `include_granted_scopes=true`, so the resulting grant folds in any scopes
that Google account has already granted this OAuth client.

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

`1 passed` on its own does not prove all three calls ran. The test asserts on `getMessage` only
when `listMessages` returned something, so an empty mailbox passes having verified only the profile
and list calls. Confirm the account has at least one message before recording the result.

## 4. Clean up

If the account was enrolled only for this test, remove it and revoke the grant:

```sh
GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
MCP_MAIL_ACCOUNT_ID='gmail-livetest' \
MCP_MAIL_CONFIRM_REMOVE=true \
npm run remove:gmail
```

Revocation targets the grant held by that **Google account** for this OAuth client, not every
account registered locally. Other enrolled accounts belonging to *different* Google users are
separate grants and are unaffected, even though they share the client id.

It does matter when the same Google account is registered more than once — nothing stops you from
enrolling one mailbox under two account ids, since enrollment only rejects a duplicate account id.
Those registrations share one grant, so revoking through either one invalidates both. In that case
remove the test registration without revoking:

```sh
GOOGLE_OAUTH_CLIENT_ID='your-client-id' \
MCP_MAIL_ACCOUNT_ID='gmail-livetest' \
MCP_MAIL_CONFIRM_REMOVE=true \
MCP_MAIL_SKIP_REVOCATION=true \
npm run remove:gmail
```

This still deletes the Keychain item and the registry record; only the remote grant is left in
place, to be revoked from the Google account's security settings when it is no longer shared.

## Not covered here

Core never holds QQ authorization codes or iCloud app-specific passwords, so QQ and iCloud live
checks belong to their own provider repositories and are not exercised by this runbook.
