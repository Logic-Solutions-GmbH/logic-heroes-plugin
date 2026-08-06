#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [requested, ...args] = process.argv.slice(2);
if (!requested || !/^[a-z][a-z0-9-]*\.ts$/.test(requested)) {
  console.error('Usage: node scripts/run-tool.mjs <tool-name.ts> [arguments]');
  process.exit(2);
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = join(pluginRoot, 'skills', 'heroes-agent', 'scripts', 'heroes-tools');
const tool = join(toolsDir, requested);
const tsxCli = join(toolsDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tool)) {
  console.error(`Unknown Heroes tool: ${requested}`);
  process.exit(2);
}
if (!existsSync(tsxCli)) {
  console.error('Heroes tool dependencies are missing. Run node <plugin-root>/scripts/setup-tools.mjs.');
  process.exit(2);
}

const result = spawnSync(process.execPath, [tsxCli, tool, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
