import type { MailAccount, RegisteredAccount } from "./domain.js";
import { MailError } from "./errors.js";

const ACCOUNT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface AccountRegistry {
  list(): Promise<readonly RegisteredAccount[]>;
  get(id: string): Promise<RegisteredAccount | undefined>;
  add(account: RegisteredAccount): Promise<void>;
  update(id: string, patch: Partial<Pick<RegisteredAccount, "label" | "roles" | "status" | "providerIdentity">>): Promise<void>;
  remove(id: string): Promise<void>;
}

export function publicAccount(account: RegisteredAccount): MailAccount {
  const { credentialId: _credentialId, ...safe } = account;
  return safe;
}

export class InMemoryAccountRegistry implements AccountRegistry {
  readonly #accounts = new Map<string, RegisteredAccount>();

  public constructor(initial: readonly RegisteredAccount[] = []) {
    for (const account of initial) this.insert(account);
  }

  public async list(): Promise<readonly RegisteredAccount[]> { return [...this.#accounts.values()]; }
  public async get(id: string): Promise<RegisteredAccount | undefined> { return this.#accounts.get(id); }
  public async add(account: RegisteredAccount): Promise<void> {
    if (this.#accounts.has(account.id)) throw new MailError("INVALID_INPUT", `Account '${account.id}' already exists.`);
    this.insert(account);
  }
  public async update(id: string, patch: Partial<Pick<RegisteredAccount, "label" | "roles" | "status" | "providerIdentity">>): Promise<void> {
    const current = this.#accounts.get(id);
    if (!current) throw new MailError("ACCOUNT_NOT_FOUND", `Account '${id}' was not found.`);
    this.#accounts.set(id, { ...current, ...patch });
  }
  public async remove(id: string): Promise<void> {
    if (!this.#accounts.delete(id)) throw new MailError("ACCOUNT_NOT_FOUND", `Account '${id}' was not found.`);
  }
  private insert(account: RegisteredAccount): void {
    if (!ACCOUNT_ID.test(account.id)) throw new MailError("INVALID_INPUT", "Account IDs must be stable lowercase slugs.");
    if (!account.credentialId) throw new MailError("INVALID_INPUT", "credentialId is required.");
    this.#accounts.set(account.id, Object.freeze({ ...account, roles: Object.freeze([...account.roles]) }));
  }
}

/** Persists non-secret account metadata only. OAuth tokens belong in a credential store. */
export class JsonFileAccountRegistry implements AccountRegistry {
  public constructor(private readonly path: string) {}
  public async list(): Promise<readonly RegisteredAccount[]> { return [...(await this.load()).values()]; }
  public async get(id: string): Promise<RegisteredAccount | undefined> { return (await this.load()).get(id); }
  public async add(account: RegisteredAccount): Promise<void> {
    validateAccount(account);
    const values = await this.load();
    if (values.has(account.id)) throw new MailError("INVALID_INPUT", `Account '${account.id}' already exists.`);
    values.set(account.id, account); await this.save(values);
  }
  public async update(id: string, patch: Partial<Pick<RegisteredAccount, "label" | "roles" | "status" | "providerIdentity">>): Promise<void> {
    const values = await this.load(); const current = values.get(id);
    if (!current) throw new MailError("ACCOUNT_NOT_FOUND", `Account '${id}' was not found.`);
    values.set(id, { ...current, ...patch }); await this.save(values);
  }
  public async remove(id: string): Promise<void> {
    const values = await this.load();
    if (!values.delete(id)) throw new MailError("ACCOUNT_NOT_FOUND", `Account '${id}' was not found.`);
    await this.save(values);
  }
  private async load(): Promise<Map<string, RegisteredAccount>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("invalid");
      const result = new Map<string, RegisteredAccount>();
      for (const value of parsed) { validateAccount(value as RegisteredAccount); result.set((value as RegisteredAccount).id, value as RegisteredAccount); }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw new MailError("INTERNAL", "Account registry metadata is invalid.", false, { cause: error });
    }
  }
  private async save(values: Map<string, RegisteredAccount>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...values.values()], null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function validateAccount(account: RegisteredAccount): void {
  if (!account || !ACCOUNT_ID.test(account.id) || !account.provider || !account.credentialId || !account.capabilities) throw new MailError("INVALID_INPUT", "Invalid account metadata.");
}
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
