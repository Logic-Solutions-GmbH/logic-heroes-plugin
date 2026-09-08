import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(toolsDir, '..', '..', '..', '..');
const launcher = join(pluginRoot, 'scripts', 'run-tool.mjs');

function writeFakeSupabase(workspace: string): { cli: string; log: string; state: string } {
  const cli = join(workspace, 'fake-supabase.mjs');
  const log = join(workspace, 'fake-supabase.log');
  const state = join(workspace, 'fake-supabase.state');
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const secrets = ['test-access-secret', 'test-database-secret', 'test-heroes-secret'];
if (args.some((arg) => secrets.some((secret) => arg.includes(secret)))) process.exit(91);
appendFileSync(process.env.FAKE_SUPABASE_LOG, JSON.stringify({
  args,
  hasAccessToken: process.env.SUPABASE_ACCESS_TOKEN === secrets[0],
  hasDatabasePassword: process.env.SUPABASE_DB_PASSWORD === secrets[1],
  hasHeroesApiKey: !!process.env.API_KEY,
}) + '\\n');
if (args.includes('--version')) console.log('2.117.0');
else if (args[0] === 'projects' && args[1] === 'list') {
  if (process.env.FAKE_SUPABASE_MODE === 'auth') {
    console.error('Unauthorized test-access-secret');
    process.exit(1);
  }
  if (process.env.FAKE_SUPABASE_MODE === 'unreachable') {
    console.error('dial tcp: network unreachable test-access-secret');
    process.exit(1);
  }
  console.log(JSON.stringify(process.env.FAKE_SUPABASE_MODE === 'mismatch' ? [
    { id: 'zyxwvutsrqponmlkjihg', name: 'Wrong Test', region: 'us-east-1' },
  ] : [
    { id: 'abcdefghijklmnopqrst', name: 'Fresh Test', region: 'eu-central-1' },
  ]));
}
else if (args.includes('migration') && args.includes('list')) console.log(JSON.stringify([
  process.env.FAKE_SUPABASE_MODE === 'divergent'
    ? { Local: null, Remote: '20260907000100' }
    : {
        Local: '20260908000100',
        Remote: existsSync(process.env.FAKE_SUPABASE_STATE) && process.env.FAKE_SUPABASE_MODE !== 'partial'
          ? '20260908000100'
          : null,
      },
]));
else if (args.includes('db') && args.includes('push') && args.includes('--dry-run')) {
  console.log(existsSync(process.env.FAKE_SUPABASE_STATE)
    ? 'Linked project is up to date.'
    : 'Would apply migration 20260908000100_heroes_agent_bootstrap.sql');
} else if (args.includes('db') && args.includes('push')) {
  if (process.env.FAKE_SUPABASE_MODE === 'migration-fail') {
    console.error('statement failed test-database-secret');
    process.exit(1);
  }
  writeFileSync(process.env.FAKE_SUPABASE_STATE, 'applied');
  console.log('Finished supabase db push.');
} else console.log('ok');
`);
  chmodSync(cli, 0o700);
  return { cli, log, state };
}

test('bootstrap refuses a workspace without one configured Heroes tenant', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-missing-identity-'));
  try {
    const result = spawnSync(
      process.execPath,
      [launcher, 'bootstrap-supabase.ts', '--project-ref', 'abcdefghijklmnopqrst'],
      { cwd: workspace, encoding: 'utf8' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Heroes tenant identity is missing/);
    assert.doesNotMatch(result.stdout + result.stderr, /abcdefghijklmnopqrst/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('dry-run binds one tenant to one verified project without exposing credentials', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-bind-'));
  try {
    mkdirSync(join(workspace, 'self'));
    writeFileSync(
      join(workspace, 'self', 'identity.md'),
      '# Who I am\n\n- **Tenant key:** `acme-corp`\n- **Display name:** `Acme Corp`\n',
    );
    writeFileSync(
      join(workspace, 'self', '.env'),
      'API_KEY=test-heroes-secret\nSUPABASE_ACCESS_TOKEN=test-access-secret\nSUPABASE_DB_PASSWORD=test-database-secret\n',
      { mode: 0o600 },
    );
    const fake = writeFakeSupabase(workspace);

    const result = spawnSync(
      process.execPath,
      [
        launcher,
        'bootstrap-supabase.ts',
        '--project-ref',
        'abcdefghijklmnopqrst',
        '--dry-run',
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          HEROES_SUPABASE_CLI: fake.cli,
          FAKE_SUPABASE_LOG: fake.log,
          FAKE_SUPABASE_STATE: fake.state,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const bindingPath = join(workspace, 'self', 'supabase', 'binding.json');
    assert.deepEqual(JSON.parse(readFileSync(bindingPath, 'utf8')), {
      schemaVersion: '1.0',
      heroesTenantKey: 'acme-corp',
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      supabaseProjectName: 'Fresh Test',
      supabaseRegion: 'eu-central-1',
    });
    assert.equal(statSync(bindingPath).mode & 0o777, 0o600);
    assert.match(result.stdout, /acme-corp/);
    assert.match(result.stdout, /Fresh Test/);
    assert.match(result.stdout, /valid; no migration applied/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-access-secret|test-database-secret/);
    const calls = readFileSync(fake.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.every((call) => call.hasAccessToken && call.hasDatabasePassword));
    assert.ok(calls.every((call) => !call.hasHeroesApiKey));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('apply verifies the migration and a second run reports a safe no-op', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-supabase-rerun-'));
  try {
    mkdirSync(join(workspace, 'self'));
    writeFileSync(
      join(workspace, 'self', 'identity.md'),
      '# Who I am\n\n- **Tenant key:** `acme-corp`\n- **Display name:** `Acme Corp`\n',
    );
    writeFileSync(
      join(workspace, 'self', '.env'),
      'SUPABASE_ACCESS_TOKEN=test-access-secret\nSUPABASE_DB_PASSWORD=test-database-secret\n',
      { mode: 0o600 },
    );
    const fake = writeFakeSupabase(workspace);
    const env = {
      ...process.env,
      HEROES_SUPABASE_CLI: fake.cli,
      FAKE_SUPABASE_LOG: fake.log,
      FAKE_SUPABASE_STATE: fake.state,
    };

    const first = spawnSync(
      process.execPath,
      [launcher, 'bootstrap-supabase.ts', '--project-ref', 'abcdefghijklmnopqrst'],
      { cwd: workspace, encoding: 'utf8', env },
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /connected; migrations verified/);

    const second = spawnSync(
      process.execPath,
      [launcher, 'bootstrap-supabase.ts'],
      { cwd: workspace, encoding: 'utf8', env },
    );
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /already up to date; no migration applied/);
    assert.doesNotMatch(
      first.stdout + first.stderr + second.stdout + second.stderr,
      /test-access-secret|test-database-secret/,
    );
    const calls = readFileSync(fake.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commands = calls.map((call) => call.args.join(' '));
    assert.equal(commands.some((command) => command.includes('migration repair')), false);
    assert.equal(commands.filter((command) => command.includes('db push') && command.includes('--dry-run')).length, 2);
    assert.equal(commands.filter((command) => command.includes('db push') && !command.includes('--dry-run')).length, 2);
    const firstPlan = commands.findIndex((command) => command.includes('db push') && command.includes('--dry-run'));
    const firstApply = commands.findIndex((command) => command.includes('db push') && !command.includes('--dry-run'));
    const verification = commands.findIndex(
      (command, index) => index > firstApply && command.includes('migration list'),
    );
    assert.ok(firstPlan >= 0 && firstPlan < firstApply && firstApply < verification);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('bootstrap returns stable redacted failures for unsafe remote states', () => {
  const cases = [
    { mode: 'auth', code: 'authentication_failed' },
    { mode: 'unreachable', code: 'project_unreachable' },
    { mode: 'mismatch', code: 'project_identity_mismatch' },
    { mode: 'migration-fail', code: 'migration_failed' },
    { mode: 'divergent', code: 'migration_history_mismatch' },
    { mode: 'partial', code: 'migration_partial' },
  ];
  for (const expected of cases) {
    const workspace = mkdtempSync(join(tmpdir(), `heroes-supabase-${expected.mode}-`));
    try {
      mkdirSync(join(workspace, 'self'));
      writeFileSync(
        join(workspace, 'self', 'identity.md'),
        '# Who I am\n\n- **Tenant key:** `acme-corp`\n- **Display name:** `Acme Corp`\n',
      );
      writeFileSync(
        join(workspace, 'self', '.env'),
        'SUPABASE_ACCESS_TOKEN=test-access-secret\nSUPABASE_DB_PASSWORD=test-database-secret\n',
        { mode: 0o600 },
      );
      const fake = writeFakeSupabase(workspace);
      const result = spawnSync(
        process.execPath,
        [launcher, 'bootstrap-supabase.ts', '--project-ref', 'abcdefghijklmnopqrst'],
        {
          cwd: workspace,
          encoding: 'utf8',
          env: {
            ...process.env,
            HEROES_SUPABASE_CLI: fake.cli,
            FAKE_SUPABASE_LOG: fake.log,
            FAKE_SUPABASE_STATE: fake.state,
            FAKE_SUPABASE_MODE: expected.mode,
          },
        },
      );
      assert.equal(result.status, 1, `${expected.mode}: ${result.stdout}`);
      assert.match(result.stderr, new RegExp(`\\[${expected.code}\\]`));
      assert.doesNotMatch(result.stdout + result.stderr, /test-access-secret|test-database-secret/);
      if (expected.mode === 'migration-fail') {
        const retry = spawnSync(
          process.execPath,
          [launcher, 'bootstrap-supabase.ts'],
          {
            cwd: workspace,
            encoding: 'utf8',
            env: {
              ...process.env,
              HEROES_SUPABASE_CLI: fake.cli,
              FAKE_SUPABASE_LOG: fake.log,
              FAKE_SUPABASE_STATE: fake.state,
              FAKE_SUPABASE_MODE: expected.mode,
            },
          },
        );
        assert.equal(retry.status, 1);
        assert.match(retry.stderr, /\[migration_partial\]/);
        assert.match(retry.stderr, /operator must inspect/);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});
