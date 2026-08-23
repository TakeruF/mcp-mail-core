import { MailError } from "./errors.js";
import type { MailProviderAdapter } from "./provider.js";

type OptionalMethod = "getThread" | "getAttachment" | "createDraft" | "updateDraft" | "sendDraft" | "send" | "reply" | "forward" | "archive" | "trash" | "setFlags";

export type ProviderContractReport = Readonly<{
  providerId: string;
  valid: boolean;
  violations: readonly string[];
}>;

/** Pure structural checks that provider packages can run in their own tests. */
export function inspectProviderContract(adapter: MailProviderAdapter): ProviderContractReport {
  const violations: string[] = [];
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(adapter.id)) violations.push("provider id must be a lowercase stable slug");
  for (const method of ["health", "search", "getMessage"] as const) {
    if (typeof adapter[method] !== "function") violations.push(`${method} is required`);
  }

  match(violations, adapter, "getThread", adapter.capabilities.threads !== false, "threads");
  match(violations, adapter, "getAttachment", adapter.capabilities.attachments, "attachments");
  match(violations, adapter, "send", adapter.capabilities.send, "send");
  match(violations, adapter, "reply", adapter.capabilities.reply, "reply");
  match(violations, adapter, "forward", adapter.capabilities.forward, "forward");
  match(violations, adapter, "archive", adapter.capabilities.archive, "archive");
  match(violations, adapter, "trash", adapter.capabilities.trash, "trash");
  match(violations, adapter, "setFlags", adapter.capabilities.flags.length > 0, "flags");
  for (const method of ["createDraft", "updateDraft", "sendDraft"] as const) {
    match(violations, adapter, method, adapter.capabilities.drafts, "drafts");
  }
  if (adapter.capabilities.permanentDelete) violations.push("permanentDelete is unsupported by this Core version");
  if (new Set(adapter.capabilities.flags).size !== adapter.capabilities.flags.length) violations.push("flags must not contain duplicates");

  return Object.freeze({ providerId: adapter.id, valid: violations.length === 0, violations: Object.freeze(violations) });
}

/** Fails host construction before any account or remote mailbox operation runs. */
export function assertProviderContract(adapter: MailProviderAdapter): void {
  const report = inspectProviderContract(adapter);
  if (!report.valid) throw new MailError("INVALID_INPUT", `Provider '${adapter.id}' violates the adapter contract: ${report.violations.join("; ")}.`);
}

function match(violations: string[], adapter: MailProviderAdapter, method: OptionalMethod, advertised: boolean, capability: string): void {
  const implemented = typeof adapter[method] === "function";
  if (advertised && !implemented) violations.push(`${capability} is advertised but ${method} is missing`);
  if (!advertised && implemented) violations.push(`${method} is implemented but ${capability} is not advertised`);
}
