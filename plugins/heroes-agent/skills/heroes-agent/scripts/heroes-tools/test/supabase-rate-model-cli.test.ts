import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

function writeWorkspace(workspace: string): void {
  mkdirSync(join(workspace, 'self', 'supabase'), { recursive: true });
  writeFileSync(
    join(workspace, 'self', 'identity.md'),
    '# Who I am\n\n- **Tenant key:** `acme`\n- **Display name:** `Acme Corp`\n',
  );
  writeFileSync(
    join(workspace, 'self', '.env'),
    'SUPABASE_ACCESS_TOKEN=test-access-secret\nSUPABASE_DB_PASSWORD=test-database-secret\n',
    { mode: 0o600 },
  );
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
  hasAccessToken: process.env.SUPABASE_ACCESS_TOKEN === 'test-access-secret',
  hasDatabasePassword: !!process.env.SUPABASE_DB_PASSWORD,
}) + '\\n');
if (request.action === 'project') {
  process.stdout.write(JSON.stringify({ ref: 'enjephpxfrbccskdljun', name: 'user-db', region: 'eu-west-1' }));
} else if (request.action === 'query-read-only' && request.query.includes('s4b_verification')) {
  const required = ['pg_catalog.pg_policy', 'relrowsecurity', 'aclexplode', 'pg_catalog.pg_depend',
    'security_invoker', 'rate_record_identity', 'rate_model_state', 'pg_catalog.pg_auth_members',
    'heroes_agent_acme', 'heroes.catalog_response_hash', 'heroes.query_valid_from',
    'heroes.query_valid_to', 'membership.member =', '$policy$', 'pg_catalog.replace',
    "member_role.rolname = 'postgres'", 'membership.roleid = agent_role.oid',
    'membership.member = agent_role.oid', 'membership.admin_option',
    'not membership.inherit_option', 'not membership.set_option'];
  if (required.some((value) => !request.query.includes(value))) {
    process.stderr.write('verification query is incomplete');
    process.exit(8);
  }
  if (request.query.includes("not like '%heroes_catalog_response_hash%'") ||
      !request.query.includes("current_setting(''heroes_catalog_response_hash''") ||
      !request.query.includes('pg_catalog.strpos')) {
    process.stderr.write('verification confuses the physical column with the legacy setting key');
    process.exit(8);
  }
  if (request.query.split('a.grantee not in (').length - 1 < 3) {
    process.stderr.write('verification must reject unexpected schema, relation, and function grantees');
    process.exit(8);
  }
  const verification = {
    binding: true, schema: true, table: true, constraints: true, grants: true,
    rls: true, policies: true, invokerSecurity: true, dependencies: true,
  };
  if (existsSync(process.env.FAKE_QUERY_LOG + '.fail-verification')) verification.policies = false;
  process.stdout.write(JSON.stringify([{ verification }]));
} else if (request.action === 'query-read-only' && request.query.includes('s4b_cleanup_verification')) {
  const required = ['heroes_agent_other_probe', 'pg_catalog.pg_auth_members', 's4b-policy-card',
    'membership.admin_option', 'not membership.inherit_option', 'not membership.set_option'];
  if (required.some((value) => !request.query.includes(value))) {
    process.stderr.write('cleanup verification query is incomplete');
    process.exit(8);
  }
  if (!request.query.includes("member_role.rolname = 'postgres'") ||
      !request.query.includes('membership.roleid = agent_role.oid') ||
      !request.query.includes('membership.member = agent_role.oid')) {
    process.stderr.write('cleanup verification must preserve only the managed postgres membership');
    process.exit(8);
  }
  process.stdout.write(JSON.stringify([{ cleanup: {
    rolledBack: !existsSync(process.env.FAKE_QUERY_LOG + '.fail-cleanup'),
  } }]));
} else if (request.action === 'query-read-only') {
  const installed = existsSync(process.env.FAKE_QUERY_LOG + '.installed');
  process.stdout.write(JSON.stringify([{ metadata: {
    schemas: [{ name: 'heroes_agent_control' }, ...(installed ? [{ name: 'heroes_agent_rates' }] : [])],
    relations: [{ schema: 'heroes_agent_control', name: 'bootstrap_state', kind: 'table', rls_enabled: false, rls_forced: false }],
    migration_history: [
      { version: '20260908000100', name: 'heroes_agent_bootstrap' },
      ...(installed ? [
        { version: '20260912000100', name: 'acme_rate_model' },
        { version: '20260912000200', name: 'acme_rate_context_key' },
        { version: '20260912000300', name: 'acme_rate_query_context' },
      ] : []),
    ],
  } }]));
} else if (request.action === 'query-write') {
  const required = ['begin', 'set local role heroes_agent_acme', 'heroes_agent_other_probe',
    'cross_tenant_insert_rejected', 'rollback', 'heroes.tenant_key',
    'grant heroes_agent_other_probe',
    'grant heroes_agent_acme to %i with set true'];
  if (required.some((value) => !request.query.toLowerCase().includes(value))) {
    process.stderr.write('policy proof query is incomplete');
    process.exit(8);
  }
  if (request.query.toLowerCase().includes('revoke heroes_agent_acme')) {
    process.stderr.write('policy proof must restore the managed membership through rollback');
    process.exit(8);
  }
  if (request.query.toLowerCase().includes('with admin true, inherit false, set true')) {
    process.stderr.write('policy proof must change only the managed SET option');
    process.exit(8);
  }
  if (request.query.includes("'strategy', null")) {
    process.stderr.write('policy proof must omit the optional strategy field instead of sending JSON null');
    process.exit(8);
  }
  const proof = {
    sameTenantRead: true, sameTenantWrite: true, crossTenantReadCount: 0,
    crossTenantUpdateCount: 0, crossTenantDeleteCount: 0,
    crossTenantInsertRejected: true, forgedAcmeContextBlocked: true, rolledBack: true,
  };
  if (existsSync(process.env.FAKE_QUERY_LOG + '.fail-proof')) proof.crossTenantInsertRejected = false;
  process.stdout.write(JSON.stringify([{ proof }]));
} else {
  process.stderr.write('unexpected action');
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
  process.stdout.write(existsSync(process.env.FAKE_SUPABASE_STATE + '.wrong-version')
    ? '2.117.0-dev\\n' : '2.117.0\\n');
} else if (args.includes('migration') && args.includes('list')) {
  const applied = existsSync(process.env.FAKE_SUPABASE_STATE);
  process.stdout.write(JSON.stringify({ migrations: [
    { local: '20260908000100', remote: '20260908000100', time: '2026-09-08 00:01:00' },
    { local: '20260912000100', remote: applied ? '20260912000100' : '', time: '2026-09-12 00:01:00' },
    { local: '20260912000200', remote: applied ? '20260912000200' : '', time: '2026-09-12 00:02:00' },
    { local: '20260912000300', remote: applied ? '20260912000300' : '', time: '2026-09-12 00:03:00' },
  ], message: 'Migrations listed' }));
} else if (args.includes('db') && args.includes('push') && args.includes('--dry-run')) {
  process.stdout.write(existsSync(process.env.FAKE_SUPABASE_STATE) ? 'Linked project is up to date.' : 'Would apply rate model.');
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
  runner: { path: string; log: string },
  args: string[],
  supabase?: { path: string; log: string; state: string },
) {
  return spawnSync(process.execPath, [launcher, 'supabase-rate-model.ts', ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROES_SUPABASE_QUERY_RUNNER: runner.path,
      FAKE_QUERY_LOG: runner.log,
      ...(supabase ? {
        HEROES_SUPABASE_CLI: supabase.path,
        FAKE_SUPABASE_LOG: supabase.log,
        FAKE_SUPABASE_STATE: supabase.state,
      } : {}),
    },
  });
}

test('discover and propose inspect the exact binding without a database write', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-discover-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);

    const discover = runTool(workspace, runner, ['discover']);
    assert.equal(discover.status, 0, discover.stderr || discover.stdout);
    const discovery = JSON.parse(discover.stdout);
    assert.deepEqual(discovery.binding, {
      heroesTenantKey: 'acme',
      supabaseProjectRef: 'enjephpxfrbccskdljun',
      supabaseProjectName: 'user-db',
      supabaseRegion: 'eu-west-1',
    });
    assert.deepEqual(discovery.schemas, ['heroes_agent_control']);
    assert.equal(discovery.rateSchemaExists, false);

    const propose = runTool(workspace, runner, ['propose']);
    assert.equal(propose.status, 0, propose.stderr || propose.stdout);
    const proposal = JSON.parse(propose.stdout);
    assert.match(proposal.proposalHash, /^[0-9a-f]{64}$/);
    assert.equal(proposal.profile.profileVersion, '1.0');
    assert.equal(proposal.profile.status, 'proposal');
    assert.deepEqual(proposal.profile.binding, {
      heroesTenantKey: 'acme',
      supabaseProjectRef: 'enjephpxfrbccskdljun',
    });
    assert.equal(proposal.profile.resources.find((resource: { id: string }) => resource.id === 'store').name,
      'heroes_agent_rates.rate_records');

    const calls = readFileSync(runner.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map(({ action }) => action), ['project', 'query-read-only']);
    assert.ok(calls.every((call) => call.hasAccessToken));
    assert.ok(calls.every((call) => !call.hasDatabasePassword));
    assert.doesNotMatch(discover.stdout + discover.stderr + propose.stdout + propose.stderr,
      /test-access-secret|test-database-secret/);
    assert.equal(readFileSync(join(workspace, 'self', 'supabase', 'binding.json'), 'utf8').includes('rate-profile'), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('discover verifies every installed metadata section when the rate schema exists', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-discover-installed-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    writeFileSync(`${runner.log}.installed`, 'installed');

    const discover = runTool(workspace, runner, ['discover']);
    assert.equal(discover.status, 0, discover.stderr || discover.stdout);
    const result = JSON.parse(discover.stdout);
    assert.equal(result.rateSchemaExists, true);
    assert.deepEqual(result.verification, {
      binding: true, schema: true, table: true, constraints: true, grants: true,
      rls: true, policies: true, invokerSecurity: true, dependencies: true,
    });

    const calls = readFileSync(runner.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map(({ action }) => action), ['project', 'query-read-only', 'query-read-only']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('install verifies the migration before profile persistence and reruns as a safe no-op', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-install-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    const proposed = runTool(workspace, runner, ['propose']);
    const { proposalHash } = JSON.parse(proposed.stdout);

    const first = runTool(workspace, runner, ['install', '--proposal-hash', proposalHash], supabase);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.status, 'installed-and-verified');
    assert.equal(firstResult.migrationApplied, true);
    assert.equal(firstResult.proposalHash, proposalHash);

    const profilePath = join(workspace, 'self', 'supabase', 'rate-profile.json');
    assert.equal(existsSync(profilePath), true);
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    assert.equal(profile.status, 'confirmed');
    assert.deepEqual(profile.binding, {
      heroesTenantKey: 'acme',
      supabaseProjectRef: 'enjephpxfrbccskdljun',
    });
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'migration-attempt.json')), false);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
      '20260912000100_acme_rate_model.sql')), true);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
      '20260912000200_acme_rate_context_key.sql')), true);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'project', 'supabase', 'migrations',
      '20260912000300_acme_rate_query_context.sql')), true);

    const second = runTool(workspace, runner, ['install', '--proposal-hash', proposalHash], supabase);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(JSON.parse(second.stdout).migrationApplied, false);

    const reloaded = runTool(workspace, runner, ['reload']);
    assert.equal(reloaded.status, 0, reloaded.stderr || reloaded.stdout);
    assert.deepEqual(JSON.parse(reloaded.stdout), {
      status: 'confirmed',
      proposalHash,
      heroesTenantKey: 'acme',
      supabaseProjectRef: 'enjephpxfrbccskdljun',
    });

    const cliCalls = readFileSync(supabase.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commands = cliCalls.map(({ args }) => args.join(' '));
    assert.equal(commands.filter((command) => command.includes('db push') && !command.includes('--dry-run')).length, 1);
    assert.equal(commands.some((command) => command.includes('migration repair')), false);
    assert.equal(commands.some((command) => command.includes(' link ')), false);
    assert.ok(cliCalls.every((call) => call.hasAccessToken && call.hasDatabasePassword));
    assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr,
      /test-access-secret|test-database-secret/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('confirm accepts only the current proposal hash and does not persist an operational profile', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-confirm-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const proposed = runTool(workspace, runner, ['propose']);
    assert.equal(proposed.status, 0, proposed.stderr);
    const { proposalHash } = JSON.parse(proposed.stdout);

    const stale = runTool(workspace, runner, ['confirm', '--proposal-hash', '0'.repeat(64)]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /\[proposal_mismatch\]/);

    const confirmed = runTool(workspace, runner, ['confirm', '--proposal-hash', proposalHash]);
    assert.equal(confirmed.status, 0, confirmed.stderr || confirmed.stdout);
    assert.deepEqual(JSON.parse(confirmed.stdout), {
      status: 'confirmed-for-installation',
      proposalHash,
      heroesTenantKey: 'acme',
      supabaseProjectRef: 'enjephpxfrbccskdljun',
    });
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'rate-profile.json')), false);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'rate-model-confirmation.json')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('install keeps the attempt marker and withholds the profile when database verification fails', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-failed-verification-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    writeFileSync(`${runner.log}.fail-verification`, 'fail');
    const proposed = runTool(workspace, runner, ['propose']);
    const { proposalHash } = JSON.parse(proposed.stdout);

    const installed = runTool(workspace, runner, ['install', '--proposal-hash', proposalHash], supabase);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /\[verification_failed\]/);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'rate-profile.json')), false);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'migration-attempt.json')), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('install withholds the profile when the database tenant-policy proof fails', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-failed-policy-proof-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    writeFileSync(`${runner.log}.fail-proof`, 'fail');
    const proposed = runTool(workspace, runner, ['propose']);
    const { proposalHash } = JSON.parse(proposed.stdout);

    const installed = runTool(workspace, runner, ['install', '--proposal-hash', proposalHash], supabase);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /\[verification_failed\]/);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'rate-profile.json')), false);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'migration-attempt.json')), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('install verifies rollback cleanup after the policy query and marks a failed no-op retry', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-failed-cleanup-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    writeFileSync(supabase.state, 'applied');
    writeFileSync(`${runner.log}.fail-cleanup`, 'fail');
    const proposed = runTool(workspace, runner, ['propose']);
    const { proposalHash } = JSON.parse(proposed.stdout);

    const installed = runTool(workspace, runner, ['install', '--proposal-hash', proposalHash], supabase);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /\[verification_failed\]/);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'rate-profile.json')), false);
    assert.equal(existsSync(join(workspace, 'self', 'supabase', 'migration-attempt.json')), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('install requires the exact pinned Supabase CLI release', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-cli-version-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const supabase = writeFakeSupabase(workspace);
    writeFileSync(`${supabase.state}.wrong-version`, 'wrong');
    const proposed = runTool(workspace, runner, ['propose']);
    const { proposalHash } = JSON.parse(proposed.stdout);

    const installed = runTool(workspace, runner, ['install', '--proposal-hash', proposalHash], supabase);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /Supabase CLI 2\.117\.0 is required/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('understanding: the stable S4a identity keeps distinct charges and repeat writes do not mutate rows', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-model-understanding-'));
  try {
    writeWorkspace(workspace);
    const runner = writeQueryRunner(workspace);
    const proposed = runTool(workspace, runner, ['propose']);
    assert.equal(proposed.status, 0, proposed.stderr || proposed.stdout);
    const profile = JSON.parse(proposed.stdout).profile;
    assert.deepEqual(profile.controls.idempotency.fields,
      ['tenant.key', 'card.id', 'rule.id', 'source.sourceHash']);

    const migration = readFileSync(join(pluginRoot, 'skills', 'heroes-agent', 'assets',
      'supabase-rate-model', 'acme', 'migrations', '20260912000100_acme_rate_model.sql'), 'utf8');
    assert.match(migration,
      /unique \(tenant_key, card_id, rule_id, source_hash, charge_key\)/i);
    assert.match(migration, /on conflict on constraint rate_record_identity do nothing/i);
    assert.doesNotMatch(migration,
      /on conflict on constraint rate_record_identity do update/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('roll-forward uses a valid dotted PostgreSQL tenant context without rewriting applied history', () => {
  const originalMigration = readFileSync(join(pluginRoot, 'skills', 'heroes-agent', 'assets',
    'supabase-rate-model', 'acme', 'migrations', '20260912000100_acme_rate_model.sql'), 'utf8');
  const correctionMigration = readFileSync(join(pluginRoot, 'skills', 'heroes-agent', 'assets',
    'supabase-rate-model', 'acme', 'migrations', '20260912000200_acme_rate_context_key.sql'), 'utf8');
  const queryContextMigration = readFileSync(join(pluginRoot, 'skills', 'heroes-agent', 'assets',
    'supabase-rate-model', 'acme', 'migrations', '20260912000300_acme_rate_query_context.sql'), 'utf8');

  assert.match(originalMigration, /current_setting\('heroes_tenant_key', true\)/);
  assert.match(correctionMigration, /current_setting\('heroes\.tenant_key', true\)/);
  assert.doesNotMatch(correctionMigration, /current_setting\('heroes_tenant_key', true\)/);
  assert.match(correctionMigration, /migration_version = '20260912000200'/);
  assert.match(queryContextMigration, /current_setting\('heroes\.catalog_response_hash', true\)/);
  assert.match(queryContextMigration, /current_setting\('heroes\.query_valid_from', true\)/);
  assert.match(queryContextMigration, /current_setting\('heroes\.query_valid_to', true\)/);
  assert.doesNotMatch(queryContextMigration, /heroes_(?:catalog_response_hash|query_valid_(?:from|to))/);
  assert.match(queryContextMigration, /migration_version = '20260912000300'/);
});
