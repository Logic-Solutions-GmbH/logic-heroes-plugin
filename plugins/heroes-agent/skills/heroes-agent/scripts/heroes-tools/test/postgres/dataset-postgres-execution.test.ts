import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeDatasetProposal } from '../../dataset-proposal';
import {
  assertDatasetPostgresVerification,
  buildDatasetPostgresVerificationQuery,
  DATASET_VERIFICATION_FIELDS,
  readDatasetPostgresVerification,
} from '../../dataset-postgres-verifier';
import { LocalPostgresSeam } from '../../local-postgres-seam';
import { isTcpPortOpen, startPostgresHarness, type PostgresHarness } from '../support/postgres-harness';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = join(toolsDir, 'test', 'fixtures', 'dataset-cli', 'product-prices.manifest.json');
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
const table = 'acme__product_prices';
const tenantRole = 'heroes_agent_beta';
const migrationVersion = '20260919120000';
const rows = [
  {
    sku: 'SKU-001', external_ref: 'REF-001', region: 'EU', price: 10.5, active: true,
    source_file: 'prices.csv', source_ref: 'row-1', source_hash: 'source-1',
    approval_status: 'approved', approved_by: 'owner', approved_at: '2026-09-19T09:00:00Z',
    content_hash: 'content-1',
  },
  {
    sku: 'SKU-002', external_ref: 'REF-002', region: 'EU', price: 12, active: true,
    source_file: 'prices.csv', source_ref: 'row-2', source_hash: 'source-2',
    approval_status: 'approved', approved_by: 'owner', approved_at: '2026-09-19T09:01:00Z',
    content_hash: 'content-2',
  },
  {
    sku: 'SKU-003', external_ref: 'REF-003', region: 'US', price: 15, active: false,
    source_file: 'prices.csv', source_ref: 'row-3', source_hash: 'source-3',
    approval_status: 'approved', approved_by: 'owner', approved_at: '2026-09-19T09:02:00Z',
    content_hash: 'content-3',
  },
];

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

test('reports a PostgreSQL start failure and removes its data directory', { timeout: 30_000 }, async () => {
  const databaseDirectories = (): string[] => readdirSync(tmpdir())
    .filter((name) => name.startsWith('heroes-postgres-'))
    .sort();
  const before = databaseDirectories();

  await assert.rejects(
    startPostgresHarness({ postgresFlags: ['--heroes-force-start-failure'] }),
    (error: any) => error instanceof Error
      && error.message.includes('PostgreSQL failed to start:')
      && error.message.includes('--heroes-force-start-failure'),
  );

  assert.deepEqual(databaseDirectories(), before);
});

test('executes generated dataset DDL on isolated PostgreSQL 17', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-postgres-proof-'));
  const repeatWorkspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-postgres-repeat-'));
  const manifest = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  let harness: PostgresHarness | undefined;

  try {
    harness = await startPostgresHarness();
    const seam = new LocalPostgresSeam(harness.client);
    const adminSeam = new LocalPostgresSeam(harness.adminClient);
    const proposal = writeDatasetProposal({ workspace, manifest, tenantKey, migrationVersion });
    const migrationPaths = proposal.files.map(({ path }) => join(workspace, path));

    await seam.applyMigrations([bootstrapPath, ...migrationPaths]);

    const membership = await seam.runQuery(`
      SELECT member_role.rolname AS member, membership.admin_option,
        membership.inherit_option, membership.set_option
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles tenant_role ON tenant_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
      WHERE tenant_role.rolname = '${tenantRole}'
    `);
    assert.deepEqual(membership, [{
      member: 'postgres', admin_option: true, inherit_option: false, set_option: false,
    }]);

    const verification = readDatasetPostgresVerification(await seam.runQuery(
      buildDatasetPostgresVerificationQuery(manifest, tenantKey),
    ));
    assertDatasetPostgresVerification(verification);
    assert.deepEqual(
      DATASET_VERIFICATION_FIELDS.filter((field) => verification[field] !== true),
      [],
    );

    await adminSeam.runQuery(`SET ROLE "${tenantRole}"`);
    const inserted = await adminSeam.runQuery(
      `SELECT heroes_agent_datasets.ingest_${table}(${sqlJson(rows)}) AS inserted_count`,
    );
    assert.equal(inserted[0]?.inserted_count, '3');
    const queried = await adminSeam.runQuery(
      `SELECT sku, external_ref, region, price::text AS price
       FROM heroes_agent_datasets.query_${table}(${sqlJson({ region: 'EU' })})
       ORDER BY sku`,
    );
    assert.deepEqual(queried, [
      { sku: 'SKU-001', external_ref: 'REF-001', region: 'EU', price: '10.5' },
      { sku: 'SKU-002', external_ref: 'REF-002', region: 'EU', price: '12' },
    ]);
    await adminSeam.runQuery('RESET ROLE');

    const functionSource = await seam.runQuery(`
      SELECT procedure.prosrc AS source
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = procedure.pronamespace
      WHERE namespace_row.nspname = 'heroes_agent_datasets'
        AND procedure.proname = 'query_${table}'
    `);
    assert.equal(typeof functionSource[0]?.source, 'string');
    const explainedBody = (functionSource[0]!.source as string)
      .replaceAll('"p_filters"', sqlJson({ region: 'EU' }));
    await adminSeam.runQuery('BEGIN');
    try {
      await adminSeam.runQuery(`SET LOCAL ROLE "${tenantRole}"`);
      await adminSeam.runQuery('SET LOCAL enable_seqscan = off');
      const plan = await adminSeam.runQuery(
        `EXPLAIN (FORMAT JSON) ${explainedBody}`,
      );
      assert.match(JSON.stringify(plan), /Index Scan/);
      assert.match(JSON.stringify(plan), /by_external_ref/);
    } finally {
      await adminSeam.runQuery('ROLLBACK');
    }

    await adminSeam.runQuery(`SET ROLE "${tenantRole}"`);
    const identicalIngest = await adminSeam.runQuery(
      `SELECT heroes_agent_datasets.ingest_${table}(${sqlJson(rows)}) AS inserted_count`,
    );
    assert.equal(identicalIngest[0]?.inserted_count, '0');
    await assert.rejects(
      adminSeam.runQuery(`SELECT heroes_agent_datasets.ingest_${table}(${sqlJson([{ ...rows[0], price: 99 }])})`),
      (error: any) => error?.code === 'HD001',
    );
    await assert.rejects(
      adminSeam.runQuery(`SELECT heroes_agent_datasets.ingest_${table}(${sqlJson([
        {
          sku: 'SKU-004', external_ref: 'REF-004', region: 'EU', price: 20, active: true,
          source_file: 'prices.csv', source_ref: 'row-4', source_hash: 'source-4',
          approval_status: 'approved', approved_by: 'owner', approved_at: '2026-09-19T09:03:00Z',
          content_hash: 'content-4',
        },
        { ...rows[1], price: 99 },
      ])})`),
      (error: any) => error?.code === 'HD001',
    );
    const count = await adminSeam.runQuery(`SELECT count(*)::int AS count FROM heroes_agent_datasets."${table}"`);
    assert.equal(count[0]?.count, 3);
    await adminSeam.runQuery('RESET ROLE');

    const ownerRows = await seam.runQuery(
      `SELECT count(*)::int AS count FROM heroes_agent_datasets."${table}"`,
    );
    assert.equal(ownerRows[0]?.count, 0);

    await adminSeam.runQuery(`
      CREATE ROLE heroes_agent_other_probe NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT USAGE ON SCHEMA heroes_agent_datasets TO heroes_agent_other_probe;
      GRANT SELECT, INSERT ON TABLE heroes_agent_datasets."${table}" TO heroes_agent_other_probe;
    `);
    await adminSeam.runQuery('BEGIN');
    try {
      await adminSeam.runQuery(`SET LOCAL ROLE "${tenantRole}"`);
      const ownRows = await adminSeam.runQuery(
        `SELECT count(*)::int AS count FROM heroes_agent_datasets."${table}"`,
      );
      assert.equal(ownRows[0]?.count, 3);
      await adminSeam.runQuery('RESET ROLE');
      await adminSeam.runQuery('SET LOCAL ROLE heroes_agent_other_probe');
      const otherRows = await adminSeam.runQuery(
        `SELECT count(*)::int AS count FROM heroes_agent_datasets."${table}"`,
      );
      assert.equal(otherRows[0]?.count, 0);
      await adminSeam.runQuery('SAVEPOINT cross_tenant_insert');
      await assert.rejects(
        adminSeam.runQuery(`INSERT INTO heroes_agent_datasets."${table}" (
          tenant_key, sku, external_ref, region, price, active, source_file, source_ref,
          source_hash, approval_status, approved_by, approved_at, content_hash
        ) VALUES (
          'beta', 'SKU-004', 'REF-004', 'EU', 20, true, 'prices.csv', 'row-4',
          'source-4', 'approved', 'owner', '2026-09-19T09:03:00Z', 'content-4'
        )`),
        (error: any) => error?.code === '42501',
      );
      await adminSeam.runQuery('ROLLBACK TO SAVEPOINT cross_tenant_insert');
    } finally {
      await adminSeam.runQuery('ROLLBACK');
    }

    const repeated = writeDatasetProposal({
      workspace: repeatWorkspace, manifest, tenantKey, migrationVersion,
    });
    assert.equal(repeated.hash, proposal.hash);

    await t.test('understanding: the proof checks executable state, isolation, and stable evidence', () => {
      assert.equal(verification.role, true, 'the tenant role is real catalog state');
      assert.equal(verification.rls, true, 'the table forces tenant row isolation');
      assert.equal(repeated.hash, proposal.hash, 'the same manifest and ordered SQL keep one proposal hash');
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(repeatWorkspace, { recursive: true, force: true });
    if (harness) {
      const { databaseDir, port } = harness;
      await harness.stop();
      assert.equal(existsSync(databaseDir), false);
      assert.equal(await isTcpPortOpen(port), false);
    }
  }
});
