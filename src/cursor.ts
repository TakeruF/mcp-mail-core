import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MailError } from "./errors.js";

type CursorPayload = { v: 1; fingerprint: string; cursors: Record<string, string | null> };

export function queryFingerprint(accountIds: readonly string[], query: unknown, limitPerAccount: number): string {
  return createHash("sha256").update(stableJson({ accountIds, query, limitPerAccount })).digest("base64url");
}

export function encodeCrossAccountCursor(payload: CursorPayload, secret: Uint8Array): string {
  assertSecret(secret);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function decodeCrossAccountCursor(value: string, expectedFingerprint: string, secret: Uint8Array): CursorPayload {
  assertSecret(secret);
  if (value.length > 64_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new MailError("INVALID_CURSOR", "Invalid cross-account cursor.");
  try {
    const [encoded, suppliedMac] = value.split(".");
    if (!encoded || !suppliedMac || !safeEqual(suppliedMac, sign(encoded, secret))) throw new Error("signature mismatch");
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isCursor(parsed) || parsed.fingerprint !== expectedFingerprint) throw new Error("mismatch");
    return parsed;
  } catch {
    throw new MailError("INVALID_CURSOR", "The cursor does not match this account selection and query.");
  }
}

export async function loadOrCreateCursorSecret(path: string): Promise<Buffer> {
  try { return parseSecret(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MailError("INTERNAL", "Could not read the cursor signing key.", false, { cause: error });
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString("base64url");
  try { await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return parseSecret(await readFile(path, "utf8"));
    throw new MailError("INTERNAL", "Could not create the cursor signing key.", false, { cause: error });
  }
  return parseSecret(value);
}

function isCursor(value: unknown): value is CursorPayload {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.v === 1 && typeof item.fingerprint === "string" && !!item.cursors && typeof item.cursors === "object";
}

function sign(value: string, secret: Uint8Array): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url"); const rightBuffer = Buffer.from(right, "base64url");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
function assertSecret(secret: Uint8Array): void { if (secret.byteLength < 32) throw new MailError("INTERNAL", "Cursor signing keys must contain at least 32 bytes."); }
function parseSecret(value: string): Buffer { const secret = Buffer.from(value.trim(), "base64url"); assertSecret(secret); return secret; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
