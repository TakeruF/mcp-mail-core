import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MailError } from "../errors.js";

export type GmailCredentials = Readonly<{
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  grantedScopes: readonly string[];
}>;

export interface GmailCredentialStore {
  get(credentialId: string): Promise<GmailCredentials | undefined>;
  put(credentialId: string, credentials: GmailCredentials, options?: { overwrite?: boolean }): Promise<void>;
  delete(credentialId: string): Promise<void>;
}

export class InMemoryGmailCredentialStore implements GmailCredentialStore {
  readonly #values = new Map<string, GmailCredentials>();
  public async get(id: string) { return this.#values.get(id); }
  public async put(id: string, value: GmailCredentials, options: { overwrite?: boolean } = {}): Promise<void> {
    if (this.#values.has(id) && options.overwrite !== true) throw new MailError("INVALID_INPUT", `Credentials '${id}' already exist.`);
    this.#values.set(id, Object.freeze({ ...value, grantedScopes: Object.freeze([...value.grantedScopes]) }));
  }
  public async delete(id: string): Promise<void> { this.#values.delete(id); }
}

/** macOS local/private deployment store. Secret material stays in the user's login Keychain. */
export class MacOsKeychainGmailCredentialStore implements GmailCredentialStore {
  readonly #exec = promisify(execFile);
  public constructor(private readonly service = "mcp-mail-core.gmail") {}

  public async get(credentialId: string): Promise<GmailCredentials | undefined> {
    try {
      const { stdout } = await this.#exec("security", ["find-generic-password", "-s", this.service, "-a", credentialId, "-w"], { maxBuffer: 128 * 1024 });
      return parseCredentials(stdout.trim());
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 44) return undefined;
      throw new MailError("INTERNAL", "Could not read Gmail credentials from macOS Keychain.", false, { cause: error });
    }
  }

  public async put(credentialId: string, credentials: GmailCredentials, options: { overwrite?: boolean } = {}): Promise<void> {
    if (options.overwrite !== true && await this.get(credentialId)) throw new MailError("INVALID_INPUT", `Credentials '${credentialId}' already exist.`);
    const args = ["add-generic-password", "-s", this.service, "-a", credentialId, "-w", JSON.stringify(credentials)];
    if (options.overwrite === true) args.push("-U");
    try { await this.#exec("security", args, { maxBuffer: 128 * 1024 }); }
    catch (error) { throw new MailError("INTERNAL", "Could not save Gmail credentials to macOS Keychain.", false, { cause: error }); }
  }

  public async delete(credentialId: string): Promise<void> {
    try { await this.#exec("security", ["delete-generic-password", "-s", this.service, "-a", credentialId]); }
    catch (error) {
      if ((error as { code?: number }).code !== 44) throw new MailError("INTERNAL", "Could not remove Gmail credentials from macOS Keychain.", false, { cause: error });
    }
  }
}

function parseCredentials(value: string): GmailCredentials {
  try {
    const parsed = JSON.parse(value) as Partial<GmailCredentials>;
    if (!parsed.refreshToken || !Array.isArray(parsed.grantedScopes)) throw new Error("invalid");
    return { refreshToken: parsed.refreshToken, grantedScopes: parsed.grantedScopes, ...(parsed.accessToken ? { accessToken: parsed.accessToken } : {}), ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}) };
  } catch {
    throw new MailError("INTERNAL", "Stored Gmail credentials are invalid.");
  }
}
