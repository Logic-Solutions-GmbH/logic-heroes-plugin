#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const allowed = new Set(['--check']);
const unknown = process.argv.slice(2).filter((arg) => !allowed.has(arg));
if (unknown.length) {
  console.error('Usage: node scripts/setup-tools.mjs [--check]');
  process.exit(2);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
  console.error(`Heroes Agent requires Node.js 18 or newer; found ${process.versions.node}.`);
  process.exit(1);
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = join(pluginRoot, 'skills', 'heroes-agent', 'scripts', 'heroes-tools');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  const result = spawnSync(npmCommand, args, {
    cwd: toolsDir,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['ci']);
if (process.argv.includes('--check')) {
  run(['run', 'typecheck']);
  run(['test']);
  const helperTest = spawnSync(process.execPath, [join(pluginRoot, 'scripts', 'test-helpers.mjs')], {
    cwd: pluginRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (helperTest.error) {
    console.error(helperTest.error.message);
    process.exit(1);
  }
  if (helperTest.status !== 0) process.exit(helperTest.status ?? 1);
}
