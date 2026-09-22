import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDatasetKernel } from '../../dataset-kernel';
import type { DatasetManifest } from '../../dataset-manifest';
import { writeDatasetProposal } from '../../dataset-proposal';
import { openLocalDatasetStore } from '../../local-dataset-store';
import { LocalPostgresSeam } from '../../local-postgres-seam';
import { openPostgresDatasetStore } from '../../postgres-dataset-store';
import { isTcpPortOpen, startPostgresHarness, type PostgresHarness } from '../support/postgres-harness';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bootstrapPath = resolve(
  toolsDir,
  '..',
  '..',
  'assets',
  'supabase-project',
  'supabase',
  'migrations',
  '20260908000100_heroes_agent_bootstrap.sql',
);
const tenantKey = 'beta';
const tenantRole = 'heroes_agent_beta';
const table = 'acme__store_prices';
const migrationVersion = '20260922120000';

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

const manifest = {
  schemaVersion: '1.0',
  dataset: 'acme.store_prices',
  fields: [
    { name: 'sku', type: 'text', required: true },
    { name: 'external_ref', type: 'text', required: true },
    { name: 'region', type: 'text', required: true },
    { name: 'price', type: 'decimal', required: true },
    { name: 'active', type: 'boolean', required: true },
    { name: 'note', type: 'text', required: false },
    { name: 'attrs', type: 'json', required: false },
    { name: 'seen_at', type: 'timestamp', required: false },
    { name: 'source_file', type: 'text', required: true },
    { name: 'source_ref', type: 'text', required: true },
    { name: 'source_hash', type: 'text', required: true },
    { name: 'approval_status', type: 'text', required: true },
    { name: 'approved_by', type: 'text', required: true },
    { name: 'approved_at', type: 'timestamp', required: true },
    { name: 'content_hash', type: 'text', required: true },
  ],
  identity: ['sku'],
  deduplication: ['source_file', 'source_hash'],
  indexes: [{ name: 'by_external_ref', fields: ['region', 'external_ref'], unique: true }],
  filters: [{ field: 'region', operators: ['equals', 'one-of'] }],
  provenance: { sourceFile: 'source_file', sourceRef: 'source_ref', sourceHash: 'source_hash' },
  approval: {
    status: 'approval_status',
    approvedBy: 'approved_by',
    approvedAt: 'approved_at',
    contentHash: 'content_hash',
  },
} as const satisfies DatasetManifest;

const timestampIdentityManifest = {
  schemaVersion: '1.0',
  dataset: 'acme.store_events',
  fields: [
    { name: 'sku', type: 'text', required: true },
    { name: 'occurred_at', type: 'timestamp', required: true },
    { name: 'source_file', type: 'text', required: true },
    { name: 'source_ref', type: 'text', required: true },
    { name: 'source_hash', type: 'text', required: true },
    { name: 'approval_status', type: 'text', required: true },
    { name: 'approved_by', type: 'text', required: true },
    { name: 'approved_at', type: 'timestamp', required: true },
    { name: 'content_hash', type: 'text', required: true },
  ],
  identity: ['sku', 'occurred_at'],
  deduplication: ['source_file', 'source_hash'],
  indexes: [],
  filters: [],
  provenance: { sourceFile: 'source_file', sourceRef: 'source_ref', sourceHash: 'source_hash' },
  approval: {
    status: 'approval_status',
    approvedBy: 'approved_by',
    approvedAt: 'approved_at',
    contentHash: 'content_hash',
  },
} as const satisfies DatasetManifest;

const utcRow = {
  sku: 'A-1',
  external_ref: 'vendor-a',
  region: 'eu',
  price: 10.5,
  active: true,
  note: 'keep',
  attrs: { a: 1, b: 2 },
  source_file: 'prices.csv',
  source_ref: 'row-1',
  source_hash: 'source-a',
  approval_status: 'approved',
  approved_by: 'owner',
  approved_at: '2026-09-16T10:00:00Z',
  content_hash: 'content-a',
};

test('kernel over the PostgreSQL store matches the six #51 proofs', { timeout: 120_000 }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-postgres-store-'));
  const localWorkspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-postgres-store-local-'));
  let harness: PostgresHarness | undefined;

  try {
    harness = await startPostgresHarness();
    const seam = new LocalPostgresSeam(harness.client);
    const adminSeam = new LocalPostgresSeam(harness.adminClient);
    const proposal = writeDatasetProposal({ workspace, manifest, tenantKey, migrationVersion });
    const timestampProposal = writeDatasetProposal({
      workspace,
      manifest: timestampIdentityManifest,
      tenantKey,
      migrationVersion: '20260922120001',
    });
    await seam.applyMigrations([
      bootstrapPath,
      ...proposal.files.map(({ path }) => join(workspace, path)),
      ...timestampProposal.files.map(({ path }) => join(workspace, path)),
    ]);
    await adminSeam.runQuery(`SET ROLE "${tenantRole}"`);

    const store = openPostgresDatasetStore({
      runQuery: (sql) => adminSeam.runQuery(sql),
      workspace,
      manifest,
      tenantKey,
    });
    const kernel = createDatasetKernel(store);
    await kernel.defineDataset(manifest);
    await kernel.ingest(manifest.dataset, [utcRow]);
    const exportPath = await kernel.export(manifest.dataset);

    await t.test('6a: identical re-ingest returns inserted 0', async () => {
      assert.deepEqual(
        await kernel.ingest(manifest.dataset, [utcRow]),
        { inserted: 0, total: 1 },
      );
    });

    await t.test('6a: a changed row fails with the row, identity and field', async () => {
      await assert.rejects(
        kernel.ingest(manifest.dataset, [{ ...utcRow, price: 11 }]),
        /row 1 identity sku=A-1 changed field price/,
      );
    });

    await t.test('6a: a NULL / empty-text pair is not a change', async () => {
      const emptyNote = {
        ...utcRow,
        sku: 'A-2',
        external_ref: 'vendor-b',
        source_hash: 'source-b',
        content_hash: 'content-b',
        note: null,
      };
      assert.deepEqual(
        await kernel.ingest(manifest.dataset, [emptyNote]),
        { inserted: 1, total: 2 },
      );
      assert.deepEqual(
        await kernel.ingest(manifest.dataset, [{ ...emptyNote, note: '' }]),
        { inserted: 0, total: 2 },
      );
      const sqlSkip = await adminSeam.runQuery(
        `SELECT heroes_agent_datasets.ingest_${table}(${sqlJson([{ ...emptyNote, note: '' }])}) AS inserted_count`,
      );
      assert.equal(sqlSkip[0]?.inserted_count, '0');
    });

    await t.test('6a: the same timestamp instant with another offset is not a change', async () => {
      const result = await kernel.ingest(manifest.dataset, [{
        ...utcRow, approved_at: '2026-09-16T12:00:00+02:00',
      }]);
      assert.equal(result.inserted, 0);
      const sqlSkip = await adminSeam.runQuery(
        `SELECT heroes_agent_datasets.ingest_${table}(${sqlJson([{
          ...utcRow, approved_at: '2026-09-16T12:00:00+02:00',
        }])}) AS inserted_count`,
      );
      assert.equal(sqlSkip[0]?.inserted_count, '0');
    });

    await t.test('5.2: two spellings per compared type are not a change', async () => {
      assert.equal((await kernel.ingest(manifest.dataset, [{ ...utcRow, price: 10.50 }])).inserted, 0);
      assert.equal((await kernel.ingest(manifest.dataset, [{ ...utcRow, attrs: { b: 2, a: 1 } }])).inserted, 0);
      const priceSql = await adminSeam.runQuery(
        `SELECT heroes_agent_datasets.ingest_${table}('[{"sku":"A-1","external_ref":"vendor-a","region":"eu","price":10.50,"active":true,"note":"keep","attrs":{"a":1,"b":2},"source_file":"prices.csv","source_ref":"row-1","source_hash":"source-a","approval_status":"approved","approved_by":"owner","approved_at":"2026-09-16T10:00:00Z","content_hash":"content-a"}]'::jsonb) AS inserted_count`,
      );
      assert.equal(priceSql[0]?.inserted_count, '0');
      const attrsSql = await adminSeam.runQuery(
        `SELECT heroes_agent_datasets.ingest_${table}('[{"sku":"A-1","external_ref":"vendor-a","region":"eu","price":10.5,"active":true,"note":"keep","attrs":{"b":2,"a":1},"source_file":"prices.csv","source_ref":"row-1","source_hash":"source-a","approval_status":"approved","approved_by":"owner","approved_at":"2026-09-16T10:00:00Z","content_hash":"content-a"}]'::jsonb) AS inserted_count`,
      );
      assert.equal(attrsSql[0]?.inserted_count, '0');
    });

    await t.test('S2: an empty optional non-text field does not raise', async () => {
      const result = await kernel.ingest(manifest.dataset, [{
        ...utcRow,
        sku: 'A-3',
        external_ref: 'vendor-c',
        source_hash: 'source-c',
        content_hash: 'content-c',
        seen_at: '',
      }]);
      assert.equal(result.inserted, 1);
    });

    await t.test('B1: a timestamp identity field ingests through SQL', async () => {
      const inserted = await adminSeam.runQuery(
        `SELECT heroes_agent_datasets.ingest_acme__store_events(${sqlJson([{
          sku: 'E-1',
          occurred_at: '2026-09-16T10:00:00Z',
          source_file: 'events.csv',
          source_ref: 'row-1',
          source_hash: 'event-a',
          approval_status: 'approved',
          approved_by: 'owner',
          approved_at: '2026-09-16T10:00:00Z',
          content_hash: 'event-content-a',
        }])}) AS inserted_count`,
      );
      assert.equal(inserted[0]?.inserted_count, '1');
    });

    await t.test('6a: the export path is present', () => {
      assert.match(
        exportPath,
        /self\/datasets\/acme\.store_prices\/exports\/[0-9a-f]{64}\.csv$/,
      );
      assert.equal(existsSync(exportPath), true);
    });

    await t.test('6a: UTC export bytes match the local adapter', async () => {
      const localKernel = createDatasetKernel(openLocalDatasetStore(localWorkspace));
      await localKernel.defineDataset(manifest);
      await localKernel.ingest(manifest.dataset, [utcRow]);
      const localPath = await localKernel.export(manifest.dataset);
      assert.deepEqual(readFileSync(exportPath), readFileSync(localPath));
    });

    await t.test('understanding: one dataset has the same ingest and export result on PostgreSQL', () => {
      assert.equal(existsSync(exportPath), true, 'the kernel writes a CSV path from PostgreSQL rows');
      assert.match(
        exportPath,
        /self\/datasets\/acme\.store_prices\/exports\//,
        'the path is the same workspace layout as the local adapter',
      );
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(localWorkspace, { recursive: true, force: true });
    if (harness) {
      const { databaseDir, port } = harness;
      await harness.stop();
      assert.equal(existsSync(databaseDir), false);
      assert.equal(await isTcpPortOpen(port), false);
    }
  }
});
