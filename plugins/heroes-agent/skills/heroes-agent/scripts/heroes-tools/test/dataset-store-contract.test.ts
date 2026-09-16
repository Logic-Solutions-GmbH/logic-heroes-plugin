import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDatasetKernel } from '../dataset-kernel';
import type { DatasetManifest } from '../dataset-manifest';
import { openLocalDatasetStore } from '../local-dataset-store';

const manifest: DatasetManifest = {
  schemaVersion: '1.0',
  dataset: 'acme.product_prices',
  fields: [
    { name: 'sku', type: 'text', required: true },
    { name: 'external_ref', type: 'text', required: true },
    { name: 'region', type: 'text', required: true },
    { name: 'price', type: 'decimal', required: true },
    { name: 'active', type: 'boolean', required: true },
    { name: 'source_file', type: 'text', required: true },
    { name: 'source_ref', type: 'text', required: true },
    { name: 'source_hash', type: 'text', required: true },
    { name: 'approval_status', type: 'text', required: true },
    { name: 'approved_by', type: 'text', required: true },
    { name: 'approved_at', type: 'timestamp', required: true },
    { name: 'content_hash', type: 'text', required: true },
  ],
  identity: ['sku'],
  deduplication: ['source_hash'],
  indexes: [{ name: 'by_external_ref', fields: ['external_ref'], unique: true }],
  filters: [
    { field: 'region', operators: ['equals', 'one-of'] },
    { field: 'price', operators: ['range'] },
  ],
  provenance: { sourceFile: 'source_file', sourceRef: 'source_ref', sourceHash: 'source_hash' },
  approval: {
    status: 'approval_status',
    approvedBy: 'approved_by',
    approvedAt: 'approved_at',
    contentHash: 'content_hash',
  },
};

const rows = [
  {
    sku: 'A-1', external_ref: 'vendor-a', region: 'eu', price: 10.5, active: true,
    source_file: 'message.eml', source_ref: 'line-1', source_hash: 'source-a',
    approval_status: 'approved', approved_by: 'carlos',
    approved_at: '2026-09-16T12:00:00.000Z', content_hash: 'content-a',
  },
  {
    sku: 'B-2', external_ref: 'vendor-b', region: 'us', price: 12, active: false,
    source_file: 'prices.pdf', source_ref: 'page-2', source_hash: 'source-b',
    approval_status: 'draft', approved_by: 'carlos',
    approved_at: '2026-09-16T12:05:00.000Z', content_hash: 'content-b',
  },
];

test('local adapter satisfies the dataset kernel contract', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-local-dataset-'));
  const kernel = createDatasetKernel(openLocalDatasetStore(workspace));
  try {
    await kernel.defineDataset(manifest);

    await kernel.ingest(manifest.dataset, rows);
    const repeated = await kernel.ingest(manifest.dataset, rows);
    assert.deepEqual(repeated, { inserted: 0, total: 2 });
    assert.equal((await kernel.query(manifest.dataset, {
      field: 'region', operator: 'one-of', value: ['eu', 'us'],
    })).length, 2);

    await assert.rejects(
      kernel.ingest(manifest.dataset, [
        { ...rows[0], sku: 'C-3', external_ref: 'vendor-c', source_hash: 'source-c' },
        { ...rows[1], sku: 'D-4', external_ref: 'vendor-d', source_hash: 'source-d', price: 'twelve' },
      ]),
      /row 2.*field price/,
    );
    assert.deepEqual(await kernel.query(manifest.dataset, {
      field: 'region', operator: 'equals', value: 'eu',
    }), [rows[0]]);

    await assert.rejects(
      kernel.ingest(manifest.dataset, [{ ...rows[0], sku: 'C-3', external_ref: 'vendor-c', source_hash: '' }]),
      /row 1.*field source_hash/,
    );
    await assert.rejects(
      kernel.ingest(manifest.dataset, [{ ...rows[0], sku: 'C-3', external_ref: '', source_hash: 'source-c' }]),
      /row 1.*field external_ref/,
    );

    await assert.rejects(
      kernel.ingest(manifest.dataset, [{ ...rows[0], price: 11 }]),
      /identity sku=A-1.*field price/,
    );
    assert.deepEqual(await kernel.query(manifest.dataset, {
      field: 'region', operator: 'equals', value: 'eu',
    }), [rows[0]]);

    assert.deepEqual(await kernel.query(manifest.dataset, {
      field: 'region', operator: 'equals', value: 'us',
    }), [rows[1]]);
    await assert.rejects(
      kernel.query(manifest.dataset, { field: 'active', operator: 'equals', value: true }),
      /undeclared filter field: active/,
    );
    await assert.rejects(
      kernel.query(manifest.dataset, { field: 'region', operator: 'range', value: { from: 'a', to: 'z' } }),
      /undeclared operator for region: range/,
    );

    const firstExport = readFileSync(await kernel.export(manifest.dataset));
    const secondExport = readFileSync(await kernel.export(manifest.dataset));
    assert.deepEqual(secondExport, firstExport);

    const [preserved] = await kernel.query(manifest.dataset, {
      field: 'region', operator: 'equals', value: 'eu',
    });
    assert.deepEqual(
      {
        source_file: preserved.source_file,
        source_ref: preserved.source_ref,
        source_hash: preserved.source_hash,
        approval_status: preserved.approval_status,
        approved_by: preserved.approved_by,
        approved_at: preserved.approved_at,
        content_hash: preserved.content_hash,
      },
      {
        source_file: 'message.eml',
        source_ref: 'line-1',
        source_hash: 'source-a',
        approval_status: 'approved',
        approved_by: 'carlos',
        approved_at: '2026-09-16T12:00:00.000Z',
        content_hash: 'content-a',
      },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
