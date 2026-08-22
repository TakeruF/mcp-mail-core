import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeCrossAccountCursor, encodeCrossAccountCursor, loadOrCreateCursorSecret, queryFingerprint } from "../src/cursor.js";

describe("cross-account cursor integrity", () => {
  it("authenticates cursor state and rejects payload tampering or another key", () => {
    const secret = Buffer.alloc(32, 1); const fingerprint = queryFingerprint(["a"], { text: "mail" }, 25);
    const cursor = encodeCrossAccountCursor({ v: 1, fingerprint, cursors: { a: "provider-page" } }, secret);
    expect(decodeCrossAccountCursor(cursor, fingerprint, secret).cursors.a).toBe("provider-page");
    const [payload, mac] = cursor.split(".");
    const tampered = `${payload?.slice(0, -1)}A.${mac}`;
    expect(() => decodeCrossAccountCursor(tampered, fingerprint, secret)).toThrow("does not match");
    expect(() => decodeCrossAccountCursor(cursor, fingerprint, Buffer.alloc(32, 2))).toThrow("does not match");
  });

  it("uses canonical query ordering for a stable fingerprint", () => {
    expect(queryFingerprint(["a"], { text: "mail", unread: true }, 25)).toBe(queryFingerprint(["a"], { unread: true, text: "mail" }, 25));
  });

  it("creates and reuses an owner-only persistent signing key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-mail-cursor-")); const path = join(directory, "cursor.key");
    const first = await loadOrCreateCursorSecret(path); const second = await loadOrCreateCursorSecret(path);
    expect(first).toEqual(second); expect(first.byteLength).toBe(32); expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
