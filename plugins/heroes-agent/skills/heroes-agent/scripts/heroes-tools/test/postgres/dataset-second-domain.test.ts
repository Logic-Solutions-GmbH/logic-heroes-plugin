import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDatasetKernel, type DatasetQuery } from '../../dataset-kernel';
import { parseDatasetManifest } from '../../dataset-manifest';
import { writeDatasetProposal } from '../../dataset-proposal';
import type { DatasetRow } from '../../dataset-store';
import { openLocalDatasetStore } from '../../local-dataset-store';
import { LocalPostgresSeam } from '../../local-postgres-seam';
import { openPostgresDatasetStore } from '../../postgres-dataset-store';
import { isTcpPortOpen, startPostgresHarness, type PostgresHarness } from '../support/postgres-harness';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = join(toolsDir, 'test', 'fixtures', 'chemical-price-book');
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
const table = 'lab__chemical_price_book';
const migrationVersion = '20260930120000';
const datasetId = 'lab.chemical_price_book';
const offsetTimestamp = '2026-01-15T10:00:00+02:00';

const manifest = parseDatasetManifest(
  JSON.parse(readFileSync(join(fixtureDir, 'manifest.json'), 'utf8')),
);
const fixtureRows = JSON.parse(readFileSync(join(fixtureDir, 'rows.json'), 'utf8')) as DatasetRow[];

function validRows(rows: DatasetRow[]): DatasetRow[] {
  return rows.filter((row) => typeof row.unit_price === 'number');
}

function sortByIdentity(rows: DatasetRow[]): DatasetRow[] {
  return [...rows].sort((left, right) => {
    const leftKey = String(left.cas_number);
    const rightKey = String(right.cas_number);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function timestampNames(): string[] {
  return manifest.fields.filter((field) => field.type === 'timestamp').map((field) => field.name);
}

/** Q5 = A: compare timestamp fields as instants, never as text. */
function assertRowsMatchAsInstants(localRows: DatasetRow[], postgresRows: DatasetRow[]): void {
  const left = sortByIdentity(localRows);
  const right = sortByIdentity(postgresRows);
  assert.equal(left.length, right.length);
  const timestamps = timestampNames();
  for (let index = 0; index < left.length; index++) {
    for (const field of manifest.fields) {
      const localValue = left[index][field.name];
      const postgresValue = right[index][field.name];
      if (timestamps.includes(field.name)) {
        assert.equal(
          Date.parse(String(localValue)),
          Date.parse(String(postgresValue)),
          `D-T instant comparison for ${field.name} on ${String(left[index].cas_number)}`,
        );
        continue;
      }
      assert.deepEqual(localValue, postgresValue, `field ${field.name}`);
    }
  }
}

function filterQueries(): DatasetQuery[] {
  return [
    { field: 'supplier', operator: 'equals', value: 'acid-corp' },
    { field: 'supplier', operator: 'one-of', value: ['acid-corp', 'base-chem'] },
    { field: 'unit_price', operator: 'range', value: { from: 1, to: 200 } },
    { field: 'approval_status', operator: 'equals', value: 'draft' },
    { field: 'approval_status', operator: 'equals', value: 'approved' },
  ];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('a second domain needs only a manifest and a rows file on both adapters', { timeout: 120_000 }, async (t) => {
  const localWorkspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-second-domain-local-'));
  const postgresWorkspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-second-domain-pg-'));
  let harness: PostgresHarness | undefined;

  try {
    harness = await startPostgresHarness();
    const seam = new LocalPostgresSeam(harness.client);
    const adminSeam = new LocalPostgresSeam(harness.adminClient);
    const proposal = writeDatasetProposal({
      workspace: postgresWorkspace,
      manifest,
      tenantKey,
      migrationVersion,
    });
    await seam.applyMigrations([
      bootstrapPath,
      ...proposal.files.map(({ path }) => join(postgresWorkspace, path)),
    ]);
    await adminSeam.runQuery(`SET ROLE "${tenantRole}"`);

    const localKernel = createDatasetKernel(openLocalDatasetStore(localWorkspace));
    const postgresKernel = createDatasetKernel(openPostgresDatasetStore({
      runQuery: (sql) => adminSeam.runQuery(sql),
      workspace: postgresWorkspace,
      manifest,
      tenantKey,
    }));

    await t.test('define', async () => {
      await localKernel.defineDataset(manifest);
      await postgresKernel.defineDataset(manifest);
      assert.deepEqual(await localKernel.query(datasetId, filterQueries()[1]), []);
      assert.deepEqual(await postgresKernel.query(datasetId, filterQueries()[1]), []);
    });

    await t.test('refusal names the row and the field, and writes nothing', async () => {
      const localIndexPath = join(localWorkspace, 'self', 'datasets', datasetId, 'index.json');
      const beforeLocal = readFileSync(localIndexPath);
      await assert.rejects(
        localKernel.ingest(datasetId, fixtureRows),
        /row 4 field unit_price must have type decimal/,
      );
      await assert.rejects(
        postgresKernel.ingest(datasetId, fixtureRows),
        /row 4 field unit_price must have type decimal/,
      );
      assert.deepEqual(readFileSync(localIndexPath), beforeLocal);
      assert.deepEqual(JSON.parse(beforeLocal.toString()).rows, []);
      const count = await adminSeam.runQuery(
        `SELECT count(*)::int AS count FROM heroes_agent_datasets."${table}"`,
      );
      assert.equal(count[0]?.count, 0);
    });

    const accepted = validRows(fixtureRows);
    let localIngest: { inserted: number; total: number } | undefined;
    let postgresIngest: { inserted: number; total: number } | undefined;

    await t.test('ingest skips the duplicate identity and keeps draft and approved', async () => {
      localIngest = await localKernel.ingest(datasetId, accepted);
      postgresIngest = await postgresKernel.ingest(datasetId, accepted);
      assert.deepEqual(localIngest, { inserted: 2, total: 2 });
      assert.deepEqual(postgresIngest, { inserted: 2, total: 2 });
      assert.deepEqual(
        await localKernel.ingest(datasetId, accepted),
        { inserted: 0, total: 2 },
      );
      assert.deepEqual(
        await postgresKernel.ingest(datasetId, accepted),
        { inserted: 0, total: 2 },
      );
    });

    await t.test('each declared filter answers on both adapters', async () => {
      const declaredFields = manifest.filters.map((filter) => filter.field).sort();
      const queriedFields = [...new Set(filterQueries().map((query) => query.field))].sort();
      assert.deepEqual(queriedFields, declaredFields);
      for (const query of filterQueries()) {
        const localRows = await localKernel.query(datasetId, query);
        const postgresRows = await postgresKernel.query(datasetId, query);
        assert.ok(localRows.length > 0, `filter ${query.field} ${query.operator}`);
        assertRowsMatchAsInstants(localRows, postgresRows);
      }
    });

    await t.test('draft and approved status stay as the row gives them', async () => {
      const localRows = sortByIdentity(
        await localKernel.query(datasetId, filterQueries()[1]),
      );
      const postgresRows = sortByIdentity(
        await postgresKernel.query(datasetId, filterQueries()[1]),
      );
      const statuses = (rows: DatasetRow[]) => Object.fromEntries(
        rows.map((row) => [row.cas_number, row.approval_status]),
      );
      assert.deepEqual(statuses(localRows), {
        '1310-73-2': 'draft',
        '7664-93-9': 'approved',
      });
      assert.deepEqual(statuses(postgresRows), statuses(localRows));
    });

    let localExportPath = '';
    let postgresExportPath = '';
    let localExportBytes = Buffer.alloc(0);
    let postgresExportBytes = Buffer.alloc(0);
    let localExportHash = '';
    let postgresExportHash = '';

    await t.test('export path exists and D-T instants match', async () => {
      localExportPath = await localKernel.export(datasetId);
      postgresExportPath = await postgresKernel.export(datasetId);
      assert.match(
        localExportPath,
        /self\/datasets\/lab\.chemical_price_book\/exports\/[0-9a-f]{64}\.csv$/,
      );
      assert.match(
        postgresExportPath,
        /self\/datasets\/lab\.chemical_price_book\/exports\/[0-9a-f]{64}\.csv$/,
      );
      assert.equal(existsSync(localExportPath), true);
      assert.equal(existsSync(postgresExportPath), true);

      localExportBytes = readFileSync(localExportPath);
      postgresExportBytes = readFileSync(postgresExportPath);
      localExportHash = sha256(localExportBytes);
      postgresExportHash = sha256(postgresExportBytes);
      assert.match(localExportHash, /^[0-9a-f]{64}$/);
      assert.match(postgresExportHash, /^[0-9a-f]{64}$/);

      const localRows = sortByIdentity(
        await localKernel.query(datasetId, { field: 'supplier', operator: 'equals', value: 'acid-corp' }),
      );
      const postgresRows = sortByIdentity(
        await postgresKernel.query(datasetId, { field: 'supplier', operator: 'equals', value: 'acid-corp' }),
      );
      const localQuotedAt = localRows[0]?.quoted_at;
      const postgresQuotedAt = postgresRows[0]?.quoted_at;
      assert.equal(localQuotedAt, offsetTimestamp);
      assert.notEqual(
        localQuotedAt,
        postgresQuotedAt,
        'D-T: local keeps +02:00 text; PostgreSQL returns UTC Z (#51)',
      );
      // D-T instant comparison — Q5 = A. Delete this assertion to prove the test can fail.
      assert.equal(
        Date.parse(String(localQuotedAt)),
        Date.parse(String(postgresQuotedAt)),
        'D-T instant comparison',
      );
    });

    await t.test('understanding: a second domain needs only a manifest and a rows file', () => {
      assert.deepEqual(localIngest, { inserted: 2, total: 2 });
      assert.deepEqual(postgresIngest, { inserted: 2, total: 2 });
      assert.equal(existsSync(localExportPath), true);
      assert.equal(existsSync(postgresExportPath), true);
      assert.match(localExportHash, /^[0-9a-f]{64}$/);
      assert.match(postgresExportHash, /^[0-9a-f]{64}$/);
      assert.notEqual(
        localExportHash,
        postgresExportHash,
        'D-T: export bytes differ because timestamp text differs (#51)',
      );
      assert.ok(
        localExportBytes.includes(Buffer.from(offsetTimestamp)),
        'the local export keeps the fixture +02:00 text',
      );
    });
  } finally {
    rmSync(localWorkspace, { recursive: true, force: true });
    rmSync(postgresWorkspace, { recursive: true, force: true });
    if (harness) {
      const { databaseDir, port } = harness;
      await harness.stop();
      assert.equal(existsSync(databaseDir), false);
      assert.equal(await isTcpPortOpen(port), false);
    }
  }
});
