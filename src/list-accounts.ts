import { homedir } from "node:os";
import { join } from "node:path";
import { JsonFileAccountRegistry, publicAccount } from "./account-registry.js";

const dataDirectory = process.env.MCP_MAIL_CORE_DATA_DIR ?? join(homedir(), "Library", "Application Support", "mcp-mail-core");
const registry = new JsonFileAccountRegistry(join(dataDirectory, "accounts.json"));
process.stdout.write(`${JSON.stringify((await registry.list()).map(publicAccount), null, 2)}\n`);
