import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
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
  const required = [
    'pg_catalog.pg_attribute', 'pg_catalog.pg_constraint', 'pg_catalog.pg_index',
    'relrowsecurity', 'relforcerowsecurity', 'pg_catalog.pg_policy',
    "has_schema_privilege", "has_table_privilege", 'pg_catalog.pg_proc',
    "heroes_agent_acme", "ingest_acme__product_prices", "query_acme__product_prices",
    "by_external_ref", "acme__product_prices_identity_key",
    "acme__product_prices_deduplication_key",
  ];
  if (required.some((part) => !request.query.includes(part))) {
    process.stderr.write('dataset verification query is incomplete');
    process.exit(8);
  }
  const installed = existsSync(process.env.FAKE_SUPABASE_STATE);
  const pass = installed && !existsSync(process.env.FAKE_QUERY_LOG + '.fail-verification');
  process.stdout.write(JSON.stringify([{ verification: {
    columns: pass,
    uniqueKeys: pass,
    indexes: pass,
    rls: pass,
    tenantPolicy: pass,
    grants: pass,
    functions: pass,
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
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SUPABASE_LOG, JSON.stringify({
  args,
  hasAccessToken: process.env.SUPABASE_ACCESS_TOKEN === 'test-access-secret',
  hasDatabasePassword: process.env.SUPABASE_DB_PASSWORD === 'test-database-secret',
}) + '\\n');
if (args.includes('--version')) {
  process.stdout.write('2.117.0\\n');
} else if (args.includes('migration') && args.includes('list')) {
  const applied = existsSync(process.env.FAKE_SUPABASE_STATE);
  process.stdout.write(JSON.stringify({ migrations: [
    { local: '20260908000100', remote: '20260908000100' },
    { local: '${migrationVersion}', remote: applied ? '${migrationVersion}' : '' },
  ] }));
} else if (args.includes('db') && args.includes('push') && args.includes('--dry-run')) {
  process.stdout.write(existsSync(process.env.FAKE_SUPABASE_STATE)
    ? 'Linked project is up to date.' : 'Would apply dataset model.');
} else if (args.includes('db') && args.includes('push')) {
  writeFileSync(process.env.FAKE_SUPABASE_STATE, 'applied');
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
    assert.match(json(wrongHash).reason, /proposal_mismatch/);
    assert.equal(existsSync(supabase.log), false);

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
    assert.match(json(failedVerification).reason, /tenantPolicy/);
    assert.equal(existsSync(join(
      workspace, 'self', 'supabase', 'datasets', dataset, 'install-attempt.json',
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

test('understanding: install binds one proposal to read-only verification before confirmation', () => {
  const source = readFileSync(resolve(toolsDir, 'supabase-dataset-model.ts'), 'utf8');
  assert.match(source, /assertDatasetPostgresVerification\(checked\)/);
  assert.match(source, /writeConfirmed\(confirmedPath\(dataset\), binding, proposal, checked\)/);
  assert.ok(
    source.indexOf('assertDatasetPostgresVerification(checked)')
      < source.indexOf('writeConfirmed(confirmedPath(dataset), binding, proposal, checked)'),
    'a failed catalog check must leave the attempt evidence and must not confirm the proposal',
  );
  assert.doesNotMatch(source, /query-write/);
});
