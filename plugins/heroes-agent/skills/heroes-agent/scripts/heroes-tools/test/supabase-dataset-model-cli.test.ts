import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');
const manifest = join(toolsDir, 'test', 'fixtures', 'dataset-cli', 'product-prices.manifest.json');
const dataset = 'acme.product_prices';
const migrationVersion = '20260918190000';
const rateMigrationVersions = [
  '20260912000100', '20260912000200', '20260912000300',
];
// Captured from the exact stdout bytes at 9b81fb4eb92d1225de294251c368b8eba163b790.
const RATE_PROPOSE_GOLDEN_SHA256 = '8fa5bfbddd6059783c14592c01aad9a4b04e4e3d438e590be019c89460507f6a';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeWorkspace(workspace: string): void {
  mkdirSync(join(workspace, 'self', 'supabase'), { recursive: true });
  writeFileSync(join(workspace, 'self', '.env'), [
    'SUPABASE_ACCESS_TOKEN=test-access-secret',
    'SUPABASE_DB_PASSWORD=test-database-secret',
    '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(workspace, 'self', 'supabase', 'binding.json'), `${JSON.stringify({
    schemaVersion: '1.0',
    heroesTenantKey: 'acme',
    supabaseProjectRef: 'test-project-ref',
    supabaseProjectName: 'test-project',
    supabaseRegion: 'eu-central-1',
  }, null, 2)}\n`);
}

function writeRateBinding(workspace: string): void {
  writeFileSync(join(workspace, 'self', 'supabase', 'binding.json'), `${JSON.stringify({
    schemaVersion: '1.0',
    heroesTenantKey: 'acme',
    supabaseProjectRef: 'enjephpxfrbccskdljun',
    supabaseProjectName: 'user-db',
    supabaseRegion: 'eu-west-1',
  }, null, 2)}\n`);
}

function writeSecondManifest(workspace: string): string {
  const path = join(workspace, 'product-costs.manifest.json');
  const value = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
  value.dataset = 'acme.product_costs';
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeQueryRunner(workspace: string): { path: string; log: string } {
  const path = join(workspace, 'fake-query-runner.mjs');
  const log = join(workspace, 'fake-query-runner.log');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(process.env.FAKE_QUERY_LOG, JSON.stringify({
  action: request.action,
  projectRef: request.projectRef,
  query: request.query,
  hasAccessToken: process.env.SUPABASE_ACCESS_TOKEN === 'test-access-secret',
  hasDatabasePassword: !!process.env.SUPABASE_DB_PASSWORD,
}) + '\\n');
if (request.action === 'project') {
  process.stdout.write(JSON.stringify({
    ref: 'test-project-ref', name: 'test-project', region: 'eu-central-1',
  }));
} else if (request.action === 'query-read-only' && request.query.includes('dataset_catalog_verification')) {
  const table = request.query.includes('acme__product_costs')
    ? 'acme__product_costs' : 'acme__product_prices';
  const required = [
    'pg_catalog.pg_attribute', 'pg_catalog.pg_constraint', 'pg_catalog.pg_index',
    'relrowsecurity', 'relforcerowsecurity', 'pg_catalog.pg_policy',
    "has_schema_privilege", "has_table_privilege", 'pg_catalog.pg_proc',
    "heroes_agent_acme", 'ingest_' + table, 'query_' + table,
    "by_external_ref", table + '_identity_key', table + '_deduplication_key',
    'policy.polpermissive', 'policy.polname =', 'pg_catalog.pg_get_expr',
    'access_row.grantee not in', 'namespace_row.nspowner', 'relation.relowner',
    'procedure.proowner', 'access_row.is_grantable', "access_row.privilege_type <> 'USAGE'",
    "access_row.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')",
    "access_row.privilege_type <> 'EXECUTE'", 'tenant_role.rolsuper',
    'tenant_role.rolbypassrls', 'pg_catalog.pg_auth_members', 'attribute.attacl',
    'bool_and(coalesce(', "'role', exists (", 'not tenant_role.rolinherit',
  ];
  if (required.some((part) => !request.query.includes(part))) {
    process.stderr.write('dataset verification query is incomplete');
    process.exit(8);
  }
  if (request.query.includes(' like ')
      || !request.query.includes("= '(tenant_key = ''acme''::text)'")
      || request.query.split('policy.polname').length - 1 !== 1
      || request.query.split('access_row.grantee not in').length - 1 !== 3
      || request.query.split('access_row.is_grantable').length - 1 !== 3
      || !request.query.includes(
        "procedure.proname = 'ingest_" + table + "' and not procedure.proretset",
      )
      || !request.query.includes(
        "procedure.proname = 'query_" + table + "' and procedure.proretset",
      )
      || !request.query.includes('procedure.prorettype = target_relation.reltype')
      || request.query.includes('procedure.prorettype = pg_catalog.to_regclass')) {
    process.stderr.write('dataset verification query does not require exact policy and ACL state');
    process.exit(8);
  }
  const installed = existsSync(process.env.FAKE_SUPABASE_STATE);
  const verification = {
    columns: installed,
    uniqueKeys: installed,
    indexes: installed,
    role: installed,
    rls: installed,
    tenantPolicy: installed,
    grants: installed,
    functions: installed,
  };
  if (existsSync(process.env.FAKE_QUERY_LOG + '.fail-verification')
      || existsSync(process.env.FAKE_QUERY_LOG + '.extra-policy')) {
    verification.tenantPolicy = false;
  }
  if (existsSync(process.env.FAKE_QUERY_LOG + '.extra-schema-role')
      || existsSync(process.env.FAKE_QUERY_LOG + '.extra-table-role')) {
    verification.grants = false;
  }
  if (existsSync(process.env.FAKE_QUERY_LOG + '.extra-function-role')) {
    verification.functions = false;
  }
  if (existsSync(process.env.FAKE_QUERY_LOG + '.unsafe-role-attributes')
      || existsSync(process.env.FAKE_QUERY_LOG + '.extra-role-membership')
      || existsSync(process.env.FAKE_QUERY_LOG + '.extra-column-grant')) {
    verification.grants = false;
  }
  if (existsSync(process.env.FAKE_QUERY_LOG + '.unsafe-role-attributes')) {
    verification.role = false;
  }
  if (existsSync(process.env.FAKE_QUERY_LOG + '.missing-function-search-path')) {
    verification.functions = false;
  }
  process.stdout.write(JSON.stringify([{ verification }]));
} else if (request.action === 'query-read-only' && request.query.includes('s4b_verification')) {
  process.stdout.write(JSON.stringify([{ verification: {
    binding: true, schema: true, table: true, constraints: true, grants: true,
    rls: true, policies: true, invokerSecurity: true, dependencies: true,
  } }]));
} else if (request.action === 'query-read-only' && request.query.includes('s4b_cleanup_verification')) {
  process.stdout.write(JSON.stringify([{ cleanup: { rolledBack: true } }]));
} else if (request.action === 'query-write') {
  process.stdout.write(JSON.stringify([{ proof: {
    sameTenantRead: true, sameTenantWrite: true, crossTenantReadCount: 0,
    crossTenantUpdateCount: 0, crossTenantDeleteCount: 0,
    crossTenantInsertRejected: true, forgedAcmeContextBlocked: true, rolledBack: true,
  } }]));
} else {
  process.stderr.write('unexpected query action');
  process.exit(9);
}
`);
  chmodSync(path, 0o700);
  return { path, log };
}

function writeFakeSupabase(workspace: string): { path: string; log: string; state: string } {
  const path = join(workspace, 'fake-supabase.mjs');
  const log = join(workspace, 'fake-supabase.log');
  const state = join(workspace, 'fake-supabase.state');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SUPABASE_LOG, JSON.stringify({
  args,
  hasAccessToken: process.env.SUPABASE_ACCESS_TOKEN === 'test-access-secret',
  hasDatabasePassword: process.env.SUPABASE_DB_PASSWORD === 'test-database-secret',
}) + '\\n');
function inspectStagedMigration() {
  const workdir = args[args.indexOf('--workdir') + 1];
  const migrationDir = join(workdir, 'supabase', 'migrations');
  const files = readdirSync(migrationDir).sort();
  const versions = files.map((file) => file.slice(0, 14));
  if (!files.includes('20260908000100_heroes_agent_bootstrap.sql')
      || new Set(versions).size !== versions.length) {
    process.stderr.write('staged migration ledger is incomplete or has duplicate versions');
    process.exit(8);
  }
  for (const file of files.filter((candidate) => candidate.includes('_acme__'))) {
    const content = readFileSync(join(migrationDir, file), 'utf8');
    const schema = content.indexOf('CREATE SCHEMA');
    const rls = content.indexOf('ENABLE ROW LEVEL SECURITY');
    const functions = content.indexOf('CREATE OR REPLACE FUNCTION');
    if (!(schema >= 0 && schema < rls && rls < functions)) {
      process.stderr.write('staged dataset migration order is invalid');
      process.exit(8);
    }
  }
  return { migrationDir, files, versions };
}
function remoteVersions() {
  return existsSync(process.env.FAKE_SUPABASE_STATE)
    ? JSON.parse(readFileSync(process.env.FAKE_SUPABASE_STATE, 'utf8'))
    : ['20260908000100'];
}
function assertPinnedOrder(versions) {
  const remote = remoteVersions();
  const latestRemote = [...remote].sort().at(-1);
  if (versions.some((version) => !remote.includes(version) && version < latestRemote)) {
    process.stderr.write('Found local migration files before the last remote migration');
    process.exit(8);
  }
}
if (args.includes('--version')) {
  process.stdout.write('2.117.0\\n');
} else if (args.includes('migration') && args.includes('list')) {
  const { versions } = inspectStagedMigration();
  const remote = remoteVersions();
  const all = [...new Set([...versions, ...remote])].sort();
  process.stdout.write(JSON.stringify({ migrations: all.map((version) => ({
    local: versions.includes(version) ? version : '',
    remote: remote.includes(version) ? version : '',
  })) }));
} else if (args.includes('db') && args.includes('push') && args.includes('--dry-run')) {
  const { versions } = inspectStagedMigration();
  if (existsSync(process.env.FAKE_SUPABASE_LOG + '.fail-dry-run')) {
    process.stderr.write('simulated migration dry-run failure');
    process.exit(8);
  }
  assertPinnedOrder(versions);
  process.stdout.write(existsSync(process.env.FAKE_SUPABASE_STATE)
    ? 'Linked project is up to date.' : 'Would apply dataset model.');
} else if (args.includes('db') && args.includes('push')) {
  const { versions } = inspectStagedMigration();
  assertPinnedOrder(versions);
  if (existsSync(process.env.FAKE_SUPABASE_LOG + '.fail-push')) {
    process.stderr.write('simulated migration failure');
    process.exit(8);
  }
  writeFileSync(process.env.FAKE_SUPABASE_STATE, JSON.stringify(versions));
  process.stdout.write('Finished supabase db push.');
} else {
  process.stderr.write('unexpected Supabase command');
  process.exit(9);
}
`);
  chmodSync(path, 0o700);
  return { path, log, state };
}

function runTool(
  workspace: string,
  tool: string,
  args: string[],
  runner?: { path: string; log: string },
  supabase?: { path: string; log: string; state: string },
) {
  return spawnSync(process.execPath, [launcher, tool, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(runner ? {
        HEROES_SUPABASE_QUERY_RUNNER: runner.path,
        FAKE_QUERY_LOG: runner.log,
      } : {}),
      ...(supabase ? {
        HEROES_SUPABASE_CLI: supabase.path,
        FAKE_SUPABASE_LOG: supabase.log,
        FAKE_SUPABASE_STATE: supabase.state,
      } : {}),
    },
  });
}

function json(result: ReturnType<typeof runTool>): Record<string, any> {
  return JSON.parse(result.stdout) as Record<string, any>;
}

function writeRemoteRateState(supabase: { state: string }): void {
  writeFileSync(supabase.state, JSON.stringify(['20260908000100', ...rateMigrationVersions]));
}

test('the generic dataset installer satisfies the rate installer contract', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-dataset-model-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);

    const discovered = runTool(workspace, 'supabase-dataset-model.ts', [
      'discover', '--manifest', manifest, '--json',
    ], runner);
    assert.equal(discovered.status, 0, discovered.stderr || discovered.stdout);
    assert.equal(json(discovered).status, 'discovered');
    assert.equal(json(discovered).dataset, dataset);

    const unsafeDataset = runTool(workspace, 'supabase-dataset-model.ts', [
      'reload', '--dataset', '../../outside', '--json',
    ]);
    assert.equal(unsafeDataset.status, 2, unsafeDataset.stderr || unsafeDataset.stdout);
    assert.equal(json(unsafeDataset).status, 'invalid');
    assert.equal(json(unsafeDataset).dataset, '../../outside');
    assert.match(json(unsafeDataset).reason, /Invalid dataset key/);

    const proposed = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
    ]);
    assert.equal(proposed.status, 0, proposed.stderr || proposed.stdout);
    assert.equal(json(proposed).status, 'proposed');
    assert.equal(json(proposed).dataset, dataset);
    const proposalHash = json(proposed).proposalHash as string;
    assert.match(proposalHash, /^[0-9a-f]{64}$/);

    const confirmed = runTool(workspace, 'supabase-dataset-model.ts', [
      'confirm', '--dataset', dataset, '--proposal-hash', proposalHash, '--json',
    ]);
    assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);
    assert.equal(json(confirmed).status, 'confirmed');

    const wrongHash = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', '0'.repeat(64), '--json',
    ], runner, supabase);
    assert.equal(wrongHash.status, 4, wrongHash.stderr || wrongHash.stdout);
    assert.equal(json(wrongHash).status, 'refused');
    assert.equal(json(wrongHash).dataset, dataset);
    assert.match(json(wrongHash).reason, /proposal_mismatch/);
    assert.equal(existsSync(supabase.log), false);

    writeRemoteRateState(supabase);
    const installed = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', proposalHash, '--json',
    ], runner, supabase);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.equal(json(installed).status, 'installed');
    assert.equal(json(installed).migrationApplied, true);
    assert.deepEqual(json(installed).verification, {
      columns: true,
      uniqueKeys: true,
      indexes: true,
      role: true,
      rls: true,
      tenantPolicy: true,
      grants: true,
      functions: true,
    });

    const reloaded = runTool(workspace, 'supabase-dataset-model.ts', [
      'reload', '--dataset', dataset, '--json',
    ]);
    assert.equal(reloaded.status, 0, reloaded.stderr || reloaded.stdout);
    assert.equal(json(reloaded).status, 'reloaded');
    assert.equal(json(reloaded).proposalHash, proposalHash);

    const second = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', proposalHash, '--json',
    ], runner, supabase);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(json(second).migrationApplied, false);

    const cliCalls = readFileSync(supabase.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commands = cliCalls.map(({ args }) => args.join(' '));
    assert.equal(commands.filter((command) => (
      command.includes('db push') && !command.includes('--dry-run')
    )).length, 1);
    assert.equal(commands.filter((command) => (
      command.includes('db push') && command.includes('--dry-run')
    )).length, 2);
    assert.ok(cliCalls.every((call) => call.hasAccessToken && call.hasDatabasePassword));

    writeFileSync(`${runner.log}.fail-verification`, 'fail');
    const failedVerification = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', proposalHash, '--json',
    ], runner, supabase);
    assert.equal(failedVerification.status, 4, failedVerification.stderr || failedVerification.stdout);
    assert.equal(json(failedVerification).status, 'refused');
    assert.equal(json(failedVerification).dataset, dataset);
    assert.match(json(failedVerification).reason, /tenantPolicy/);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'migration-attempt.json',
    )), true);

    const queryCalls = readFileSync(runner.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(queryCalls.every((call) => call.hasAccessToken));
    assert.ok(queryCalls.every((call) => !call.hasDatabasePassword));
    assert.ok(queryCalls.filter((call) => call.action !== 'project')
      .every((call) => call.action === 'query-read-only'));

    writeRateBinding(workspace);
    const rateProposal = runTool(workspace, 'supabase-rate-model.ts', ['propose']);
    assert.equal(rateProposal.status, 0, rateProposal.stderr || rateProposal.stdout);
    assert.equal(sha256(rateProposal.stdout), RATE_PROPOSE_GOLDEN_SHA256);

    assert.doesNotMatch(
      [discovered, proposed, confirmed, wrongHash, installed, reloaded, second, failedVerification]
        .map((result) => result.stdout + result.stderr).join(''),
      /test-access-secret|test-database-secret/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a generic install refuses an empty project before staging or push', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-dataset-rate-required-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    const proposed = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
    ]);
    assert.equal(proposed.status, 0, proposed.stderr || proposed.stdout);

    const refused = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', json(proposed).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(refused.status, 4, refused.stderr || refused.stdout);
    assert.equal(json(refused).status, 'refused');
    assert.equal(json(refused).dataset, dataset);
    assert.match(json(refused).reason, /Install the rate model first/);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'migration-attempt.json',
    )), false);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
      `${migrationVersion}_acme__product_prices.sql`,
    )), false);
    const cliCalls = readFileSync(supabase.log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(cliCalls.some(({ args }) => args.includes('push')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('catalog verification rejects policy, role, column, and function access drift', () => {
  const cases = [
    { marker: '.extra-policy', field: 'tenantPolicy' },
    { marker: '.extra-schema-role', field: 'grants' },
    { marker: '.extra-table-role', field: 'grants' },
    { marker: '.extra-function-role', field: 'functions' },
    { marker: '.unsafe-role-attributes', field: 'role' },
    { marker: '.extra-role-membership', field: 'grants' },
    { marker: '.extra-column-grant', field: 'grants' },
    { marker: '.missing-function-search-path', field: 'functions' },
  ];
  for (const { marker, field } of cases) {
    const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-dataset-drift-'));
    try {
      writeWorkspace(workspace);
      const runner = writeQueryRunner(workspace);
      const supabase = writeFakeSupabase(workspace);
      const proposed = runTool(workspace, 'supabase-dataset-model.ts', [
        'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
      ]);
      assert.equal(proposed.status, 0, proposed.stderr || proposed.stdout);
      const proposalHash = json(proposed).proposalHash as string;
      writeFileSync(supabase.state, JSON.stringify([
        '20260908000100', ...rateMigrationVersions, migrationVersion,
      ]));
      writeFileSync(`${runner.log}${marker}`, 'drift');

      const installed = runTool(workspace, 'supabase-dataset-model.ts', [
        'install', '--dataset', dataset, '--proposal-hash', proposalHash, '--json',
      ], runner, supabase);
      assert.equal(installed.status, 4, installed.stderr || installed.stdout);
      assert.equal(json(installed).status, 'refused');
      assert.equal(json(installed).dataset, dataset);
      assert.match(json(installed).reason, new RegExp(`differs in: ${field}`));
      assert.equal(existsSync(join(
        workspace, 'self', 'supabase', 'migration-attempt.json',
      )), true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('a second dataset keeps the full local and remote migration ledger', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-dataset-ledger-'));
  const secondVersion = '20260918190100';
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    writeRemoteRateState(supabase);

    const firstProposal = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
    ]);
    assert.equal(firstProposal.status, 0, firstProposal.stderr || firstProposal.stdout);
    const firstInstall = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', json(firstProposal).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(firstInstall.status, 0, firstInstall.stderr || firstInstall.stdout);

    const secondManifest = writeSecondManifest(workspace);
    const secondDataset = 'acme.product_costs';
    const secondProposal = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', secondManifest, '--migration-version', secondVersion, '--json',
    ]);
    assert.equal(secondProposal.status, 0, secondProposal.stderr || secondProposal.stdout);
    const secondInstall = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', secondDataset,
      '--proposal-hash', json(secondProposal).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(secondInstall.status, 0, secondInstall.stderr || secondInstall.stdout);
    assert.equal(json(secondInstall).dataset, secondDataset);

    const staged = readdirSync(join(
      workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
    )).sort();
    assert.deepEqual(staged, [
      '20260908000100_heroes_agent_bootstrap.sql',
      '20260912000100_acme_rate_model.sql',
      '20260912000200_acme_rate_context_key.sql',
      '20260912000300_acme_rate_query_context.sql',
      `${migrationVersion}_acme__product_prices.sql`,
      `${secondVersion}_acme__product_costs.sql`,
    ]);
    assert.deepEqual(JSON.parse(readFileSync(supabase.state, 'utf8')), [
      '20260908000100', ...rateMigrationVersions, migrationVersion, secondVersion,
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rate install then generic install then rate reinstall share one canonical ledger', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-rate-before-dataset-'));
  try {
    writeWorkspace(workspace);
    writeRateBinding(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    const rateProposal = runTool(workspace, 'supabase-rate-model.ts', ['propose']);
    assert.equal(rateProposal.status, 0, rateProposal.stderr || rateProposal.stdout);
    const firstRateInstall = runTool(workspace, 'supabase-rate-model.ts', [
      'install', '--proposal-hash', json(rateProposal).proposalHash,
    ], runner, supabase);
    assert.equal(firstRateInstall.status, 0, firstRateInstall.stderr || firstRateInstall.stdout);
    assert.equal(json(firstRateInstall).status, 'installed-and-verified');

    const datasetProposal = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
    ]);
    assert.equal(datasetProposal.status, 0, datasetProposal.stderr || datasetProposal.stdout);
    const datasetInstall = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset,
      '--proposal-hash', json(datasetProposal).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(datasetInstall.status, 0, datasetInstall.stderr || datasetInstall.stdout);

    const secondRateInstall = runTool(workspace, 'supabase-rate-model.ts', [
      'install', '--proposal-hash', json(rateProposal).proposalHash,
    ], runner, supabase);
    assert.equal(secondRateInstall.status, 0, secondRateInstall.stderr || secondRateInstall.stdout);
    assert.equal(json(secondRateInstall).status, 'installed-and-verified');
    assert.equal(json(secondRateInstall).migrationApplied, false);

    const staged = readdirSync(join(
      workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
    )).sort();
    assert.deepEqual(staged, [
      '20260908000100_heroes_agent_bootstrap.sql',
      '20260912000100_acme_rate_model.sql',
      '20260912000200_acme_rate_context_key.sql',
      '20260912000300_acme_rate_query_context.sql',
      `${migrationVersion}_acme__product_prices.sql`,
    ]);
    const cliCalls = readFileSync(supabase.log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(cliCalls.filter(({ args }) => (
      args.includes('push') && !args.includes('--dry-run')
    )).length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a failed dataset dry run blocks every later dataset in the shared ledger', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-dataset-attempt-'));
  const secondVersion = '20260918190100';
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    writeRemoteRateState(supabase);
    const firstProposal = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
    ]);
    assert.equal(firstProposal.status, 0, firstProposal.stderr || firstProposal.stdout);
    writeFileSync(`${supabase.log}.fail-dry-run`, 'fail');
    const failedFirst = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', json(firstProposal).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(failedFirst.status, 4, failedFirst.stderr || failedFirst.stdout);
    assert.match(json(failedFirst).reason, /migration_failed/);
    const attempt = join(workspace, 'self', 'supabase', 'migration-attempt.json');
    assert.equal(existsSync(attempt), true);
    assert.deepEqual(JSON.parse(readFileSync(supabase.state, 'utf8')), [
      '20260908000100', ...rateMigrationVersions,
    ]);
    rmSync(`${supabase.log}.fail-dry-run`);

    const secondDataset = 'acme.product_costs';
    const secondProposal = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', writeSecondManifest(workspace),
      '--migration-version', secondVersion, '--json',
    ]);
    assert.equal(secondProposal.status, 0, secondProposal.stderr || secondProposal.stdout);
    const callsBeforeSecond = readFileSync(supabase.log, 'utf8').trim().split('\n').length;
    const blockedSecond = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', secondDataset,
      '--proposal-hash', json(secondProposal).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(blockedSecond.status, 4, blockedSecond.stderr || blockedSecond.stdout);
    assert.equal(json(blockedSecond).dataset, secondDataset);
    assert.match(json(blockedSecond).reason, /migration_partial/);
    const laterCalls = readFileSync(supabase.log, 'utf8').trim().split('\n')
      .slice(callsBeforeSecond).map((line) => JSON.parse(line));
    assert.deepEqual(laterCalls.map(({ args }) => args), [['--version']]);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
      `${secondVersion}_acme__product_costs.sql`,
    )), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a failed rate migration blocks a later generic install through the global marker', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-rate-attempt-'));
  try {
    writeWorkspace(workspace);
    writeRateBinding(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    const rateProposal = runTool(workspace, 'supabase-rate-model.ts', ['propose']);
    assert.equal(rateProposal.status, 0, rateProposal.stderr || rateProposal.stdout);
    writeFileSync(`${supabase.log}.fail-push`, 'fail');
    const failedRate = runTool(workspace, 'supabase-rate-model.ts', [
      'install', '--proposal-hash', json(rateProposal).proposalHash,
    ], runner, supabase);
    assert.equal(failedRate.status, 1, failedRate.stderr || failedRate.stdout);
    assert.match(failedRate.stderr, /migration_failed/);
    const attempt = join(workspace, 'self', 'supabase', 'migration-attempt.json');
    assert.equal(existsSync(attempt), true);
    rmSync(`${supabase.log}.fail-push`);

    const datasetProposal = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
    ]);
    assert.equal(datasetProposal.status, 0, datasetProposal.stderr || datasetProposal.stdout);
    const callsBeforeDataset = readFileSync(supabase.log, 'utf8').trim().split('\n').length;
    const blockedDataset = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset,
      '--proposal-hash', json(datasetProposal).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(blockedDataset.status, 4, blockedDataset.stderr || blockedDataset.stdout);
    assert.equal(json(blockedDataset).dataset, dataset);
    assert.match(json(blockedDataset).reason, /migration_partial/);
    const laterCalls = readFileSync(supabase.log, 'utf8').trim().split('\n')
      .slice(callsBeforeDataset).map((line) => JSON.parse(line));
    assert.deepEqual(laterCalls.map(({ args }) => args), [['--version']]);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
      `${migrationVersion}_acme__product_prices.sql`,
    )), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a failed rate dry run blocks a later generic install before push', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-rate-dry-run-'));
  try {
    writeWorkspace(workspace);
    writeRateBinding(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    const rateProposal = runTool(workspace, 'supabase-rate-model.ts', ['propose']);
    assert.equal(rateProposal.status, 0, rateProposal.stderr || rateProposal.stdout);
    writeFileSync(`${supabase.log}.fail-dry-run`, 'fail');
    const failedRate = runTool(workspace, 'supabase-rate-model.ts', [
      'install', '--proposal-hash', json(rateProposal).proposalHash,
    ], runner, supabase);
    assert.equal(failedRate.status, 1, failedRate.stderr || failedRate.stdout);
    assert.match(failedRate.stderr, /migration_failed/);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'migration-attempt.json',
    )), false);
    rmSync(`${supabase.log}.fail-dry-run`);

    const datasetProposal = runTool(workspace, 'supabase-dataset-model.ts', [
      'propose', '--manifest', manifest, '--migration-version', migrationVersion, '--json',
    ]);
    assert.equal(datasetProposal.status, 0, datasetProposal.stderr || datasetProposal.stdout);
    const callsBeforeDataset = readFileSync(supabase.log, 'utf8').trim().split('\n').length;
    const refused = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset,
      '--proposal-hash', json(datasetProposal).proposalHash, '--json',
    ], runner, supabase);
    assert.equal(refused.status, 4, refused.stderr || refused.stdout);
    assert.equal(json(refused).dataset, dataset);
    assert.match(json(refused).reason, /Install the rate model first/);
    const laterCalls = readFileSync(supabase.log, 'utf8').trim().split('\n')
      .slice(callsBeforeDataset).map((line) => JSON.parse(line));
    assert.equal(laterCalls.some(({ args }) => args.includes('push')), false);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
      `${migrationVersion}_acme__product_prices.sql`,
    )), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('an early binding refusal keeps the supplied dataset envelope', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-dataset-binding-'));
  try {
    writeWorkspace(workspace);
    writeFileSync(join(workspace, 'self', 'supabase', 'binding.json'), '{}\n');
    const refused = runTool(workspace, 'supabase-dataset-model.ts', [
      'install', '--dataset', dataset, '--proposal-hash', '0'.repeat(64), '--json',
    ]);
    assert.equal(refused.status, 4, refused.stderr || refused.stdout);
    assert.equal(json(refused).status, 'refused');
    assert.equal(json(refused).dataset, dataset);
    assert.match(json(refused).reason, /project_identity_mismatch/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('understanding: install binds one proposal to read-only verification before confirmation', () => {
  const source = readFileSync(resolve(toolsDir, 'supabase-dataset-model.ts'), 'utf8');
  assert.match(source, /writeIsolatedProposal/);
  assert.match(source, /migration-attempt\.json/);
  assert.ok(
    source.indexOf('assertRateModelInstalled(binding)')
      < source.indexOf('writeAttempt(attempt, attemptRecord)'),
    'remote rate history must pass before the global attempt marker is written',
  );
  assert.ok(
    source.indexOf('if (existsSync(attempt))') < source.indexOf('const projectDir = prepareMigrations'),
    'a shared unresolved attempt must stop before another dataset enters the staged ledger',
  );
  assert.ok(
    source.indexOf('writeAttempt(attempt, attemptRecord)')
      < source.indexOf('const projectDir = prepareMigrations'),
    'the global marker must exist before persistent canonical-ledger staging starts',
  );
  assert.match(source, /assertDatasetPostgresVerification\(checked\)/);
  assert.match(source, /writeConfirmed\(confirmedPath\(dataset\), binding, proposal, checked\)/);
  assert.ok(
    source.indexOf('assertDatasetPostgresVerification(checked)')
      < source.indexOf('writeConfirmed(confirmedPath(dataset), binding, proposal, checked)'),
    'a failed catalog check must leave the attempt evidence and must not confirm the proposal',
  );
  assert.doesNotMatch(source, /query-write/);
});
