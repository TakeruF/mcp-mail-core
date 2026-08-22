/**
 * Transport-neutral MCP tool contract. A host can register these definitions with
 * MCP SDK v1 or v2 without coupling the domain package to one SDK generation.
 */
export const MAIL_TOOL_DEFINITIONS = Object.freeze([
  { name: "list_mail_accounts", readOnly: true, description: "Lists safe account metadata, roles, health, and capabilities. Never returns credential handles or tokens." },
  { name: "search_mail", readOnly: true, description: "Searches all ready accounts by default, or explicit account IDs. Results are grouped per account and always include accountId. Provider-native query text is allowed but semantics may differ by provider. Partial failures are returned separately." },
  { name: "get_message", readOnly: true, description: "Reads one selected message using an account-scoped {accountId,messageId} reference. Reads must not mark it read." },
  { name: "get_thread", readOnly: true, description: "Reads one provider-native or RFC-header thread using an account-scoped thread reference when that account supports threads." },
  { name: "get_attachment", readOnly: true, description: "Reads one bounded attachment using an account-scoped message and attachment reference." },
  { name: "send_mail", readOnly: false, description: "Sends immediately. accountId is mandatory; there is no default sending account. Requires confirm=true in this same call." },
  { name: "create_draft", readOnly: false, description: "Creates an unsent draft in one explicit account. Requires confirm=true in this same call." },
  { name: "update_draft", readOnly: false, description: "Replaces one explicit account-scoped draft. Requires the complete replacement and confirm=true in this same call." },
  { name: "send_draft", readOnly: false, description: "Sends one explicit account-scoped draft. Requires confirm=true in this same call." },
  { name: "reply_mail", readOnly: false, description: "Replies from the same account that owns the selected message. Cross-account reply provenance is rejected. Requires confirm=true." },
  { name: "forward_mail", readOnly: false, description: "Forwards one selected account-scoped message from that same account. Requires explicit recipients and confirm=true." },
  { name: "archive_mail", readOnly: false, description: "Archives explicit account-scoped messages using provider-native semantics. Requires confirm=true." },
  { name: "trash_mail", readOnly: false, description: "Moves explicit account-scoped messages to Trash using provider-native semantics. It never permanently deletes. Requires confirm=true." },
  { name: "set_mail_flags", readOnly: false, description: "Changes only explicitly supplied read/starred/answered state where supported. Requires confirm=true." },
] as const);
