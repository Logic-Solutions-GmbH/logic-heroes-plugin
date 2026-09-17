import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(toolsDir, 'test', 'fixtures', 'dataset-cli');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

function runDataset(workspace: string, args: string[]) {
  return spawnSync(process.execPath, [launcher, 'dataset.ts', ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
}

function json(result: ReturnType<typeof runDataset>): Record<string, any> {
  return JSON.parse(result.stdout) as Record<string, any>;
}

test('agent can define, ingest, query, refuse changes, and export one local dataset', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-cli-'));
  const manifest = join(fixtures, 'product-prices.manifest.json');
  const rows = join(fixtures, 'product-prices.rows.json');
  const changedRows = join(fixtures, 'product-prices.changed-identity.rows.json');
  const dataset = 'acme.product_prices';

  try {
    const defined = runDataset(workspace, ['define', '--manifest', manifest]);
    assert.equal(defined.status, 0, defined.stderr || defined.stdout);
    assert.match(defined.stdout, /Local dataset: defined/);
    assert.match(defined.stdout, /dataset\s+acme\.product_prices/);

    const firstIngest = runDataset(workspace, [
      'ingest', '--dataset', dataset, '--rows', rows, '--json',
    ]);
    assert.equal(firstIngest.status, 0, firstIngest.stderr || firstIngest.stdout);
    assert.deepEqual(json(firstIngest), {
      status: 'ingested', dataset, inserted: 2, total: 2,
    });

    const repeatedIngest = runDataset(workspace, [
      'ingest', '--dataset', dataset, '--rows', rows, '--json',
    ]);
    assert.equal(repeatedIngest.status, 0, repeatedIngest.stderr || repeatedIngest.stdout);
    assert.equal(json(repeatedIngest).inserted, 0);

    const invalidRows = join(workspace, 'invalid.rows.json');
    writeFileSync(invalidRows, 'not JSON');
    const invalidJson = runDataset(workspace, [
      'ingest', '--dataset', dataset, '--rows', invalidRows, '--json',
    ]);
    assert.equal(invalidJson.status, 2, invalidJson.stderr || invalidJson.stdout);
    assert.match(json(invalidJson).reason, /rows file is not valid JSON/);

    const queried = runDataset(workspace, [
      'query', '--dataset', dataset, '--field', 'region',
      '--operator', 'equals', '--value', 'eu', '--json',
    ]);
    assert.equal(queried.status, 0, queried.stderr || queried.stdout);
    assert.deepEqual(json(queried).rows.map((row: { sku: string }) => row.sku), ['A-1']);

    const quotedTextQuery = runDataset(workspace, [
      'query', '--dataset', dataset, '--field', 'region',
      '--operator', 'equals', '--value', '"eu"', '--json',
    ]);
    assert.equal(quotedTextQuery.status, 0, quotedTextQuery.stderr || quotedTextQuery.stdout);
    assert.deepEqual(json(quotedTextQuery).rows.map((row: { sku: string }) => row.sku), ['A-1']);

    const undeclared = runDataset(workspace, [
      'query', '--dataset', dataset, '--field', 'active',
      '--operator', 'equals', '--value', 'true', '--json',
    ]);
    assert.equal(undeclared.status, 4, undeclared.stderr || undeclared.stdout);
    assert.match(json(undeclared).reason, /undeclared filter field: active/);

    const indexPath = join(workspace, 'self', 'datasets', dataset, 'index.json');
    const beforeRefusal = readFileSync(indexPath);
    const changed = runDataset(workspace, [
      'ingest', '--dataset', dataset, '--rows', changedRows, '--json',
    ]);
    assert.equal(changed.status, 4, changed.stderr || changed.stdout);
    assert.match(json(changed).reason, /identity sku=A-1 changed field price/);
    assert.deepEqual(readFileSync(indexPath), beforeRefusal);

    const firstExport = runDataset(workspace, ['export', '--dataset', dataset, '--json']);
    assert.equal(firstExport.status, 0, firstExport.stderr || firstExport.stdout);
    const firstPath = json(firstExport).path as string;
    const firstBytes = readFileSync(firstPath);
    const secondExport = runDataset(workspace, ['export', '--dataset', dataset, '--json']);
    assert.equal(secondExport.status, 0, secondExport.stderr || secondExport.stdout);
    assert.equal(json(secondExport).path, firstPath);
    assert.deepEqual(readFileSync(json(secondExport).path), firstBytes);

    const undefinedDataset = runDataset(workspace, [
      'ingest', '--dataset', 'acme.undefined', '--rows', rows, '--json',
    ]);
    assert.equal(undefinedDataset.status, 2, undefinedDataset.stderr || undefinedDataset.stdout);
    assert.match(json(undefinedDataset).reason, /Dataset is not defined: acme\.undefined/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
