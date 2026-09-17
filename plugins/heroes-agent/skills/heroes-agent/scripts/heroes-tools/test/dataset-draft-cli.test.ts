import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(toolsDir, 'test', 'fixtures', 'dataset-draft');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

function runTool(workspace: string, tool: string, args: string[]) {
  return spawnSync(process.execPath, [launcher, tool, ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
}

function json(result: ReturnType<typeof runTool>): Record<string, any> {
  return JSON.parse(result.stdout) as Record<string, any>;
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

test('agent can stamp approved rows, ingest them once, query, export, and refuse unsafe drafts', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-draft-cli-'));
  const manifest = join(fixtures, 'product-prices.manifest.json');
  const altManifest = join(fixtures, 'product-prices-alt.manifest.json');
  const source = join(fixtures, 'product-prices.txt');
  const goodDraft = join(fixtures, 'product-prices.draft.json');
  const approvalDraft = join(fixtures, 'product-prices.approval-field.draft.json');
  const stampedPath = join(workspace, 'product-prices.stamped.json');
  const dataset = 'acme.product_prices';
  const altDataset = 'acme.product_prices_alt';
  const approvedAt = '2026-09-17T18:30:00.000Z';
  const definition = JSON.parse(readFileSync(manifest, 'utf8')) as {
    provenance: Record<'sourceFile' | 'sourceRef' | 'sourceHash', string>;
    approval: Record<'status' | 'approvedBy' | 'approvedAt' | 'contentHash', string>;
  };
  const altDefinition = JSON.parse(readFileSync(altManifest, 'utf8')) as typeof definition;

  try {
    const defined = runTool(workspace, 'dataset.ts', ['define', '--manifest', manifest, '--json']);
    assert.equal(defined.status, 0, defined.stderr || defined.stdout);

    const stamped = runTool(workspace, 'dataset-draft.ts', [
      'stamp', '--dataset', dataset, '--source', source,
      '--source-ref', 'rows 2-3 of the price table', '--draft', goodDraft,
      '--approved-by', 'carlos', '--approved-at', approvedAt,
      '--out', stampedPath, '--json',
    ]);
    assert.equal(stamped.status, 0, stamped.stderr || stamped.stdout);
    assert.equal(json(stamped).rows, 2);

    const rows = JSON.parse(readFileSync(stampedPath, 'utf8')) as Record<string, unknown>[];
    const expectedSourceHash = hash(readFileSync(source));
    assert.equal(rows[0][definition.provenance.sourceFile], source);
    assert.equal(rows[0][definition.provenance.sourceRef], 'rows 2-3 of the price table');
    assert.equal(rows[0][definition.provenance.sourceHash], expectedSourceHash);
    assert.equal(rows[0][definition.approval.status], 'approved');
    assert.equal(rows[0][definition.approval.approvedBy], 'carlos');
    assert.equal(rows[0][definition.approval.approvedAt], approvedAt);
    assert.equal(
      rows[0][definition.approval.contentHash],
      hash(JSON.stringify({ sku: 'A-1', region: 'eu', price: 10.5 })),
    );
    assert.equal(
      rows[1][definition.approval.contentHash],
      hash(JSON.stringify({ sku: 'B-2', region: 'us', price: 12 })),
    );
    assert.notEqual(
      rows[0][definition.approval.contentHash],
      rows[1][definition.approval.contentHash],
    );

    const altDefined = runTool(workspace, 'dataset.ts', [
      'define', '--manifest', altManifest, '--json',
    ]);
    assert.equal(altDefined.status, 0, altDefined.stderr || altDefined.stdout);
    const altStampedPath = join(workspace, 'product-prices-alt.stamped.json');
    const altStamped = runTool(workspace, 'dataset-draft.ts', [
      'stamp', '--dataset', altDataset, '--source', source,
      '--source-ref', 'rows 2-3 of the price table', '--draft', goodDraft,
      '--approved-by', 'carlos', '--approved-at', approvedAt,
      '--out', altStampedPath, '--json',
    ]);
    assert.equal(altStamped.status, 0, altStamped.stderr || altStamped.stdout);
    const altRows = JSON.parse(readFileSync(altStampedPath, 'utf8')) as Record<string, unknown>[];
    assert.equal(altRows[0][altDefinition.provenance.sourceFile], source);
    assert.equal(altRows[0][altDefinition.provenance.sourceRef], 'rows 2-3 of the price table');
    assert.equal(altRows[0][altDefinition.provenance.sourceHash], expectedSourceHash);
    assert.equal(altRows[0][altDefinition.approval.status], 'approved');
    assert.equal(altRows[0][altDefinition.approval.approvedBy], 'carlos');
    assert.equal(altRows[0][altDefinition.approval.approvedAt], approvedAt);
    assert.equal(
      altRows[0][altDefinition.approval.contentHash],
      hash(JSON.stringify({ sku: 'A-1', region: 'eu', price: 10.5 })),
    );
    for (const firstManifestRole of [
      ...Object.values(definition.provenance), ...Object.values(definition.approval),
    ]) {
      assert.equal(firstManifestRole in altRows[0], false);
    }

    const absentDraft = join(workspace, 'missing-price.absent.json');
    const nullDraft = join(workspace, 'missing-price.null.json');
    writeFileSync(absentDraft, '[{"sku":"C-3","region":"eu"}]\n');
    writeFileSync(nullDraft, '[{"sku":"C-3","region":"eu","price":null}]\n');
    const absentStampedPath = join(workspace, 'missing-price.absent.stamped.json');
    const nullStampedPath = join(workspace, 'missing-price.null.stamped.json');
    for (const [draftPath, outputPath] of [
      [absentDraft, absentStampedPath], [nullDraft, nullStampedPath],
    ]) {
      const missingStamped = runTool(workspace, 'dataset-draft.ts', [
        'stamp', '--dataset', dataset, '--source', source,
        '--source-ref', 'missing price', '--draft', draftPath,
        '--approved-by', 'carlos', '--approved-at', approvedAt,
        '--out', outputPath, '--json',
      ]);
      assert.equal(missingStamped.status, 0, missingStamped.stderr || missingStamped.stdout);
    }
    const absentRow = JSON.parse(readFileSync(absentStampedPath, 'utf8'))[0] as Record<string, unknown>;
    const nullRow = JSON.parse(readFileSync(nullStampedPath, 'utf8'))[0] as Record<string, unknown>;
    assert.equal(
      absentRow[definition.approval.contentHash],
      nullRow[definition.approval.contentHash],
    );

    const emptyDraft = join(workspace, 'empty.json');
    const emptyOutput = join(workspace, 'empty.stamped.json');
    writeFileSync(emptyDraft, '[]\n');
    const empty = runTool(workspace, 'dataset-draft.ts', [
      'stamp', '--dataset', dataset, '--source', source,
      '--source-ref', 'no rows', '--draft', emptyDraft,
      '--approved-by', 'carlos', '--approved-at', approvedAt,
      '--out', emptyOutput, '--json',
    ]);
    assert.equal(empty.status, 2, empty.stderr || empty.stdout);
    assert.match(json(empty).reason, /draft file has no rows/);
    assert.equal(existsSync(emptyOutput), false);

    const firstIngest = runTool(workspace, 'dataset.ts', [
      'ingest', '--dataset', dataset, '--rows', stampedPath, '--json',
    ]);
    assert.equal(firstIngest.status, 0, firstIngest.stderr || firstIngest.stdout);
    assert.equal(json(firstIngest).inserted, 2);

    const repeatedIngest = runTool(workspace, 'dataset.ts', [
      'ingest', '--dataset', dataset, '--rows', stampedPath, '--json',
    ]);
    assert.equal(repeatedIngest.status, 0, repeatedIngest.stderr || repeatedIngest.stdout);
    assert.equal(json(repeatedIngest).inserted, 0);

    const queried = runTool(workspace, 'dataset.ts', [
      'query', '--dataset', dataset, '--field', 'region',
      '--operator', 'equals', '--value', 'eu', '--json',
    ]);
    assert.equal(queried.status, 0, queried.stderr || queried.stdout);
    assert.deepEqual(json(queried).rows.map((row: { sku: string }) => row.sku), ['A-1']);

    const exported = runTool(workspace, 'dataset.ts', ['export', '--dataset', dataset, '--json']);
    assert.equal(exported.status, 0, exported.stderr || exported.stdout);
    const csvPath = json(exported).path as string;
    assert.equal(existsSync(csvPath), true);
    const csv = readFileSync(csvPath, 'utf8');
    assert.match(csv, /A-1/);
    assert.match(csv, /B-2/);

    const refused = runTool(workspace, 'dataset-draft.ts', [
      'stamp', '--dataset', dataset, '--source', source,
      '--source-ref', 'row 2 of the price table', '--draft', approvalDraft,
      '--approved-by', 'carlos', '--approved-at', approvedAt,
      '--out', join(workspace, 'refused.json'), '--json',
    ]);
    assert.equal(refused.status, 4, refused.stderr || refused.stdout);
    assert.match(json(refused).reason, /reserved field: review_state/);

    const undefinedDataset = runTool(workspace, 'dataset-draft.ts', [
      'stamp', '--dataset', 'acme.undefined', '--source', source,
      '--source-ref', 'rows 2-3 of the price table', '--draft', goodDraft,
      '--approved-by', 'carlos', '--approved-at', approvedAt,
      '--out', join(workspace, 'undefined.json'), '--json',
    ]);
    assert.equal(undefinedDataset.status, 2, undefinedDataset.stderr || undefinedDataset.stdout);
    assert.match(json(undefinedDataset).reason, /Dataset is not defined: acme\.undefined/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
