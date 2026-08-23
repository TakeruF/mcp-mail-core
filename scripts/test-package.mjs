import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
const temporary = await mkdtemp(resolve(tmpdir(), "mcp-mail-core-package-"));

try {
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", temporary], { cwd: root })).stdout);
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return an artifact filename.");

  const artifact = resolve(temporary, filename);
  const files = new Set(packed[0]?.files?.map((entry) => entry.path) ?? []);
  for (const required of ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"]) {
    if (!files.has(required)) throw new Error(`Package artifact is missing ${required}.`);
  }
  if ([...files].some((path) => path.startsWith("src/") || path.startsWith("tests/"))) {
    throw new Error("Package artifact unexpectedly contains source or tests.");
  }

  await writeFile(resolve(temporary, "package.json"), '{"name":"mcp-mail-core-consumer","private":true,"type":"module"}\n');
  await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", artifact], { cwd: temporary });
  await exec("node", ["--input-type=module", "--eval", [
    "import { InMemoryAccountRegistry, MultiAccountMailService } from 'mcp-mail-core';",
    "import { inspectProviderContract } from 'mcp-mail-core/testing';",
    "if (typeof InMemoryAccountRegistry !== 'function' || typeof MultiAccountMailService !== 'function') process.exit(1);",
    "if (typeof inspectProviderContract !== 'function') process.exit(1);",
  ].join("\n")], { cwd: temporary });

  await writeFile(resolve(temporary, "contract.ts"), [
    "import type { MailProviderAdapter, ReplyMessage } from 'mcp-mail-core';",
    "import { inspectProviderContract } from 'mcp-mail-core/testing';",
    "declare const adapter: MailProviderAdapter;",
    "const reply: ReplyMessage = { text: 'hello', replyAll: true };",
    "void adapter; void reply; void inspectProviderContract;",
  ].join("\n"));
  await writeFile(resolve(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [],
    },
    include: ["contract.ts"],
  }));
  await exec("node", [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: temporary });

  const installed = JSON.parse(await readFile(resolve(temporary, "node_modules/mcp-mail-core/package.json"), "utf8"));
  process.stdout.write(`fresh package install, runtime exports, and declarations ok (${installed.version})\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
