#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const initializer = join(pluginRoot, 'scripts', 'init-peer.mjs');
const sandbox = mkdtempSync(join(tmpdir(), 'heroes-agent-helpers-'));
const destination = join(sandbox, 'run', 'nested', 'acme-corp');

try {
  const first = spawnSync(process.execPath, [
    initializer,
    destination,
    '--tenant-key',
    'acme-corp',
    '--display-name',
    'Acme Corp',
  ], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.ok(existsSync(join(destination, 'self', 'identity.md')));
  assert.match(readFileSync(join(destination, 'self', 'identity.md'), 'utf8'), /`acme-corp`/);
  assert.ok(existsSync(join(destination, 'self', '.env.example')));
  assert.equal(existsSync(join(destination, 'self', '.env')), false);
  assert.equal(existsSync(join(destination, '.env')), false);

  const second = spawnSync(process.execPath, [
    initializer,
    destination,
    '--tenant-key',
    'acme-corp',
    '--display-name',
    'Changed Name',
  ], { encoding: 'utf8' });
  assert.equal(second.status, 1, 'existing destination must be refused');
  assert.match(second.stderr, /Refusing to overwrite existing destination/);
  assert.match(readFileSync(join(destination, 'self', 'identity.md'), 'utf8'), /`Acme Corp`/);
  console.log('Helper integration checks passed (nested init, no secret env, overwrite refusal).');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
