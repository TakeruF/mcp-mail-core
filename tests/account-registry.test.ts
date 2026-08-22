import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileAccountRegistry, type RegisteredAccount } from "../src/index.js";

const account: RegisteredAccount = { id: "gmail-personal", provider: "gmail", label: "Personal", roles: ["personal"], status: "ready", credentialId: "gmail:gmail-personal", capabilities: { search: true, nativeSearch: true, threads: "native", labels: true, folders: false, attachments: true, drafts: true, send: true, reply: true, forward: true, archive: true, trash: true, permanentDelete: false, flags: ["read", "starred"] } };

describe("JSON account registry", () => {
  it("persists only account metadata with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-mail-core-test-")); const path = join(directory, "accounts.json");
    const registry = new JsonFileAccountRegistry(path); await registry.add(account);
    expect((await registry.get(account.id))?.label).toBe("Personal");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, "utf8"); expect(raw).toContain("gmail:gmail-personal"); expect(raw).not.toContain("refreshToken");
    await registry.update(account.id, { label: "Home" }); expect((await registry.get(account.id))?.label).toBe("Home");
    await registry.remove(account.id); expect(await registry.list()).toEqual([]);
  });
});
