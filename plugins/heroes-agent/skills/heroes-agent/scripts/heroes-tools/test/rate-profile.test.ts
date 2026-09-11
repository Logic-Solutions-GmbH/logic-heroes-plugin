import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  RATE_PROFILE_PATH,
  loadConfirmedRateProfile,
  normalizeRateProfile,
  parseRateProfile,
  persistConfirmedRateProfile,
  resolveRateField,
  resolveRateOperation,
} from '../rate-profile';

const testDir = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(testDir, '..');
const fixturesDir = join(testDir, 'fixtures');
const expectedIdentity = {
  heroesTenantKey: 'acme',
  supabaseProjectRef: 'abcdefghijklmnopqrst',
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
}

function writeBinding(workspace: string): void {
  const path = join(workspace, 'self', 'supabase', 'binding.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', ...expectedIdentity }), { mode: 0o600 });
}

test('two physical schemas normalize to one semantic business contract', () => {
  const reference = parseRateProfile(fixture('rate-profile-reference.json'), expectedIdentity);
  const alternative = parseRateProfile(fixture('rate-profile-alternative.json'), expectedIdentity);

  assert.deepEqual(normalizeRateProfile(reference), normalizeRateProfile(alternative));
  assert.notDeepEqual(reference.resources, alternative.resources);
  assert.notDeepEqual(reference.fields, alternative.fields);
  assert.deepEqual(resolveRateField(reference, 'charge.currency'), {
    resource: { id: 'store', kind: 'table', name: 'private_rates.rate_records' },
    path: 'currency',
  });
  assert.deepEqual(resolveRateField(alternative, 'charge.currency'), {
    resource: { id: 'store', kind: 'table', name: 'operations.tariff_documents' },
    path: '/lines/prices/isoCurrency',
  });
  assert.equal(resolveRateOperation(reference, 'ingest').kind, 'function');
  assert.equal(resolveRateOperation(alternative, 'discover').kind, 'view');
});

test('invalid profiles fail closed with actionable errors', () => {
  const base = fixture('rate-profile-reference.json') as any;
  const cases: { name: string; change(profile: any): void; message: RegExp }[] = [
    {
      name: 'required semantic field is missing',
      change: (profile) => profile.fields = profile.fields.filter((field: any) => field.semantic !== 'charge.currency'),
      message: /missing required semantic field: charge\.currency/,
    },
    {
      name: 'semantic field is ambiguous',
      change: (profile) => profile.fields.push({ ...profile.fields[0], path: 'other_tenant' }),
      message: /semantic field is ambiguous: tenant\.key/,
    },
    {
      name: 'tenant isolation declaration is missing',
      change: (profile) => delete profile.controls.tenantIsolation,
      message: /tenant isolation must use database RLS/,
    },
    {
      name: 'RLS omits mapped table',
      change: (profile) => profile.controls.tenantIsolation.protectedResources = [],
      message: /RLS must protect mapped table: store/,
    },
    {
      name: 'grant declaration is unsafe',
      change: (profile) => profile.controls.grants.authenticated = 'select',
      message: /direct grants for PUBLIC, anon, and authenticated must be none/,
    },
    {
      name: 'grant declaration is missing',
      change: (profile) => delete profile.controls.grants,
      message: /controls\.grants must be an object/,
    },
    {
      name: 'grant declaration is incomplete',
      change: (profile) => profile.controls.grants.coveredResources = ['store'],
      message: /grant declaration must cover resource: read/,
    },
    {
      name: 'operation contract is reinterpreted',
      change: (profile) => profile.operations.discover.contract = 'user-tariff-1.0',
      message: /Operation discover must use rate-contract-1\.0/,
    },
    {
      name: 'approval safety is incomplete',
      change: (profile) => delete profile.controls.approval.contentHashField,
      message: /approval control must name approval\.contentHash/,
    },
    {
      name: 'current state rule is unsafe',
      change: (profile) => profile.controls.current.rule = 'trust-saved-state',
      message: /current control must compare the active Heroes catalog/,
    },
    {
      name: 'validity rule is unsafe',
      change: (profile) => profile.controls.validity.rule = 'overlaps-query-window',
      message: /validity control must contain the query window/,
    },
    {
      name: 'provenance declaration is incomplete',
      change: (profile) => profile.controls.provenance.fields.pop(),
      message: /provenance field is missing:/,
    },
    {
      name: 'idempotency declaration is incomplete',
      change: (profile) => profile.controls.idempotency.fields = ['tenant.key', 'card.id'],
      message: /idempotency field is missing:/,
    },
    {
      name: 'tenant identity differs',
      change: (profile) => profile.binding.heroesTenantKey = 'other',
      message: /Heroes tenant identity mismatch/,
    },
    {
      name: 'project identity differs',
      change: (profile) => profile.binding.supabaseProjectRef = 'zyxwvutsrqponmlkjihg',
      message: /Supabase project identity mismatch/,
    },
    {
      name: 'profile version is unsupported',
      change: (profile) => profile.profileVersion = '2.0',
      message: /Unsupported rate profile version: 2\.0/,
    },
  ];

  for (const expected of cases) {
    const candidate = structuredClone(base);
    expected.change(candidate);
    assert.throws(() => parseRateProfile(candidate, expectedIdentity), expected.message, expected.name);
  }
});

test('confirmed profile persists canonically and reloads in a fresh process', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-profile-'));
  try {
    writeBinding(workspace);
    const profile = parseRateProfile(fixture('rate-profile-alternative.json'), expectedIdentity);
    const path = persistConfirmedRateProfile(workspace, profile);
    const firstBytes = readFileSync(path, 'utf8');

    assert.equal(path, join(workspace, RATE_PROFILE_PATH));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(loadConfirmedRateProfile(workspace), profile);

    persistConfirmedRateProfile(workspace, profile);
    assert.equal(readFileSync(path, 'utf8'), firstBytes);

    const moduleUrl = pathToFileURL(join(toolsDir, 'rate-profile.ts')).href;
    const script = `import { loadConfirmedRateProfile } from ${JSON.stringify(moduleUrl)};\n` +
      `const value = loadConfirmedRateProfile(process.argv[1]);\n` +
      `process.stdout.write(JSON.stringify(value));\n`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, workspace], {
      cwd: toolsDir,
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), profile);

    writeFileSync(
      join(workspace, 'self', 'supabase', 'binding.json'),
      JSON.stringify({ schemaVersion: '1.0', heroesTenantKey: 'other', supabaseProjectRef: 'abcdefghijklmnopqrst' }),
    );
    assert.throws(() => loadConfirmedRateProfile(workspace), /Heroes tenant identity mismatch/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('an unconfirmed proposal cannot be persisted or loaded for operational use', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-rate-proposal-'));
  try {
    writeBinding(workspace);
    const proposal = fixture('rate-profile-reference.json') as any;
    proposal.status = 'proposal';
    const parsed = parseRateProfile(proposal, expectedIdentity);
    assert.throws(
      () => persistConfirmedRateProfile(workspace, parsed),
      /Only a confirmed rate profile can be persisted/,
    );

    const path = join(workspace, RATE_PROFILE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(proposal));
    assert.throws(
      () => loadConfirmedRateProfile(workspace),
      /Confirmed rate profile required/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
