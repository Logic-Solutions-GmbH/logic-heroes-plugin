import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  resolveTransportOrderContractPaths,
  pluginRootFromToolsDir,
} from '../transport-order-contract.ts';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = pluginRootFromToolsDir(toolsDir);
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

test('resolveTransportOrderContractPaths points at bundled files', () => {
  const paths = resolveTransportOrderContractPaths(toolsDir);
  assert.ok(existsSync(paths.guidePath));
  assert.ok(existsSync(paths.xsdPath));
  assert.ok(existsSync(paths.examplePath));
});

test('transport-order-contract.ts --json includes contract paths', () => {
  const result = spawnSync(
    process.execPath,
    [launcher, 'transport-order-contract.ts', '--json'],
    { cwd: toolsDir, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.ok(json.xsdPath.endsWith('ServiceRequest.v3.xsd'));
  assert.ok(json.examplePath.endsWith('ServiceRequest.v3.full-example.xml'));
});

test('transport-order-contract.ts validates bundled example when xmllint exists', () => {
  const xmllint = spawnSync('xmllint', ['--version'], { encoding: 'utf8' });
  if (xmllint.status !== 0) {
    return;
  }
  const paths = resolveTransportOrderContractPaths(toolsDir);
  const result = spawnSync(
    process.execPath,
    [launcher, 'transport-order-contract.ts', '--validate', paths.examplePath],
    { cwd: toolsDir, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('list-heroes-tools.ts lists transport-order-contract.ts', () => {
  const result = spawnSync(
    process.execPath,
    [launcher, 'list-heroes-tools.ts', '--json'],
    { cwd: toolsDir, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  const names = json.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes('transport-order-contract.ts'));
  assert.ok(names.includes('list-heroes-tools.ts'));
});
