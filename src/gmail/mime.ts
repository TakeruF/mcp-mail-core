import { randomBytes } from "node:crypto";
import type { OutgoingMessage } from "../domain.js";
import { MailError } from "../errors.js";

export type ThreadHeaders = Readonly<{ messageId?: string; references?: readonly string[] }>;

export function composeMime(message: OutgoingMessage, thread?: ThreadHeaders): string {
  validateHeader(message.subject);
  if (message.subject.length > 998) throw new MailError("INVALID_INPUT", "Mail subjects cannot exceed 998 characters.");
  if (message.text.length > 500_000) throw new MailError("INVALID_INPUT", "Mail text exceeds the configured size limit.");
  if (message.to.length > 100 || (message.cc?.length ?? 0) > 100 || (message.bcc?.length ?? 0) > 100) throw new MailError("INVALID_INPUT", "Mail recipient lists cannot exceed 100 addresses.");
  if ((message.attachments?.length ?? 0) > 10) throw new MailError("INVALID_INPUT", "Mail cannot contain more than 10 attachments.");
  for (const address of [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]) validateHeader(address);
  if (!message.to.length) throw new MailError("INVALID_INPUT", "At least one recipient is required.");
  const headers = [
    `To: ${message.to.join(", ")}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.join(", ")}`] : []),
    ...(message.bcc?.length ? [`Bcc: ${message.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    ...(thread?.messageId ? [`In-Reply-To: ${thread.messageId}`] : []),
    ...(thread?.references?.length ? [`References: ${thread.references.join(" ")}`] : []),
  ];
  if (!message.attachments?.length) return [...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(message.text).toString("base64")].join("\r\n");
  const boundary = `mcp-mail-core-${randomBytes(18).toString("hex")}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(message.text).toString("base64"),
  ];
  let totalAttachmentBytes = 0;
  for (const attachment of message.attachments) {
    validateHeader(attachment.filename);
    const contentType = attachment.contentType ?? "application/octet-stream";
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(contentType)) throw new MailError("INVALID_INPUT", "Attachment contentType must be a simple MIME media type.");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.contentBase64)) throw new MailError("INVALID_INPUT", "Attachment content must be canonical Base64.");
    const size = Buffer.byteLength(attachment.contentBase64, "base64");
    totalAttachmentBytes += size;
    if (size > 5 * 1024 * 1024 || totalAttachmentBytes > 20 * 1024 * 1024) throw new MailError("INVALID_INPUT", "Outgoing attachments exceed the configured size limit.");
    const filename = quotedParameter(attachment.filename);
    parts.push(`--${boundary}`, `Content-Type: ${contentType}; name="${filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${filename}"`, "", attachment.contentBase64);
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

export function base64UrlMime(value: string): string { return Buffer.from(value, "utf8").toString("base64url"); }

function validateHeader(value: string): void {
  if (/\r|\n/.test(value)) throw new MailError("INVALID_INPUT", "Mail headers cannot contain newlines.");
}
function encodeHeader(value: string): string { return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`; }
function quotedParameter(value: string): string { return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
