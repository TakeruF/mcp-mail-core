import { createHash } from "node:crypto";
import { MailError } from "./errors.js";

type CursorPayload = { v: 1; fingerprint: string; cursors: Record<string, string | null> };

export function queryFingerprint(accountIds: readonly string[], query: unknown, limitPerAccount: number): string {
  return createHash("sha256").update(JSON.stringify({ accountIds, query, limitPerAccount })).digest("base64url");
}

export function encodeCrossAccountCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCrossAccountCursor(value: string, expectedFingerprint: string): CursorPayload {
  if (value.length > 64_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new MailError("INVALID_CURSOR", "Invalid cross-account cursor.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isCursor(parsed) || parsed.fingerprint !== expectedFingerprint) throw new Error("mismatch");
    return parsed;
  } catch {
    throw new MailError("INVALID_CURSOR", "The cursor does not match this account selection and query.");
  }
}

function isCursor(value: unknown): value is CursorPayload {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.v === 1 && typeof item.fingerprint === "string" && !!item.cursors && typeof item.cursors === "object";
}
