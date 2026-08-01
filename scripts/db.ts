#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbShellHelp } from '../src/backend/db-shell.js';
import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.js';
import { applyDotEnvToProcessEnv } from '../src/backend/llm/settings.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 与 mcp-server / headless host 同语义：CLI 也是独立后端进程，父进程读 process.env
// 的变量（IFTREE_EMBED_* / IFTREE_AGENT_TIMEOUT_MS 等）需要吃到项目根 .env；
// 只填未显式设置的键，不覆盖 shell 里显式 export 的值。
applyDotEnvToProcessEnv(join(PROJECT_ROOT, '.env'));

function defaultDbPath() {
  return process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite');
}

async function exitProcess(code: number) {
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    process.exit(code);
    return;
  }
  if (process.versions.electron) {
    const { app } = await import('electron');
    if (app?.exit) {
      app.exit(code);
      return;
    }
  }
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0])) {
    console.log(dbShellHelp());
    await exitProcess(0);
    return;
  }

  const dbPath = resolve(defaultDbPath());
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    onStderr: (text) => process.stderr.write(text)
  });
  try {
    const result = await client.request('db.shell', {
      argv,
      currentDocId: process.env.IFTREE_CURRENT_DOC_ID,
      agentMode: 'full'
    }) as { text?: unknown };
    console.log(result.text || '');
  } finally {
    await client.shutdown();
    client.close();
  }
}

main()
  .then(() => exitProcess(0))
  .catch(async (error: unknown) => {
    console.error((error as { stack?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || String(error));
    await exitProcess(1);
  });
