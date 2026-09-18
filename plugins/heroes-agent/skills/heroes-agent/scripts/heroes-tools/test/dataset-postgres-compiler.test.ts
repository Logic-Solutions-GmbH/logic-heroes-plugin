import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalJson } from '../dataset-kernel';
import { writeDatasetProposal, type DatasetProposal } from '../dataset-proposal';

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(toolsDir, 'test', 'fixtures', 'dataset-cli', 'product-prices.manifest.json');
const tenantKey = 'acme';
const migrationVersion = '20260918190000';

function fixture(): Record<string, any> {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, any>;
}

function compile(
  workspace: string,
  manifest: unknown = fixture(),
  previousProposal?: DatasetProposal,
  backup?: { path: string; sha256: string; rowCount: number },
): DatasetProposal {
  return writeDatasetProposal({
    workspace,
    manifest,
    tenantKey,
    migrationVersion,
    previousProposal,
    backup,
  });
}

function fileBytes(workspace: string, proposal: DatasetProposal): Buffer[] {
  return proposal.files.map(({ path }) => readFileSync(join(workspace, path)));
}

test('compiles deterministic dataset DDL and refuses an unbacked destructive change', () => {
  const workspaces = Array.from({ length: 9 }, () => mkdtempSync(join(tmpdir(), 'heroes-dataset-ddl-')));

  try {
    const first = compile(workspaces[0]);
    const second = compile(workspaces[1]);

    assert.deepEqual(first.files, second.files);
    assert.deepEqual(fileBytes(workspaces[0], first), fileBytes(workspaces[1], second));
    assert.equal(first.hash, second.hash);
    assert.equal(first.backup, undefined);
    assert.deepEqual(
      JSON.parse(readFileSync(join(
        workspaces[0], 'self', 'supabase', 'datasets', 'acme.product_prices', 'proposal.json',
      ), 'utf8')),
      first,
    );
    assert.equal(statSync(join(
      workspaces[0], 'self', 'supabase', 'datasets', 'acme.product_prices', 'proposal.json',
    )).mode & 0o777, 0o600);
    for (const { path } of first.files) assert.equal(statSync(join(workspaces[0], path)).mode & 0o777, 0o600);

    const changedType = fixture();
    changedType.fields.find((field: any) => field.name === 'price').type = 'integer';
    assert.notEqual(compile(workspaces[2], changedType).hash, first.hash);

    const addedIndex = fixture();
    addedIndex.indexes.push({ name: 'by_price', fields: ['price'], unique: false });
    assert.notEqual(compile(workspaces[3], addedIndex).hash, first.hash);

    const sql = fileBytes(workspaces[0], first).map((bytes) => bytes.toString('utf8')).join('\n');
    assert.match(sql, /"heroes_agent_datasets"\."acme__product_prices"/);
    assert.match(sql, /"by_external_ref"/);
    assert.match(sql, /create unique index/i);
    assert.match(sql, /unique \("sku"\)/i);
    assert.match(sql, /unique \("source_file", "source_hash"\)/i);
    assert.match(sql, /enable row level security/i);
    assert.match(sql, /force row level security/i);
    assert.match(sql, /"tenant_key" = 'acme'/);
    assert.match(sql, /to "heroes_agent_acme"/i);
    assert.match(sql, /revoke all .* from public, "anon", "authenticated"/i);
    assert.match(sql, /"ingest_acme__product_prices"/);
    assert.match(sql, /"query_acme__product_prices"/);

    const removedField = fixture();
    removedField.fields = removedField.fields.filter((field: any) => field.name !== 'active');
    assert.throws(
      () => compile(workspaces[4], removedField, first),
      /destructive change.*removed field active/i,
    );
    assert.deepEqual(readdirSync(workspaces[4]), []);

    const backup = {
      path: 'self/supabase/backups/acme.product_prices.json',
      sha256: 'a'.repeat(64),
      rowCount: 17,
    };
    const backed = compile(workspaces[5], removedField, first, backup);
    assert.deepEqual(backed.backup, backup);
    const changedBackupHash = compile(
      workspaces[6],
      removedField,
      first,
      { ...backup, sha256: 'b'.repeat(64) },
    ).hash;
    const changedBackupRows = compile(
      workspaces[7],
      removedField,
      first,
      { ...backup, rowCount: backup.rowCount + 1 },
    ).hash;
    assert.notEqual(changedBackupHash, backed.hash);
    assert.notEqual(changedBackupRows, backed.hash);

    const longTable = fixture();
    longTable.dataset = `${'a'.repeat(31)}.${'b'.repeat(31)}`;
    assert.throws(() => compile(workspaces[8], longTable), /table name exceeds 63 characters/i);
    assert.deepEqual(readdirSync(workspaces[8]), []);
  } finally {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
  }
});

test('understanding: the proposal hash binds the manifest, ordered SQL files, and optional backup evidence', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'heroes-dataset-ddl-understanding-'));
  try {
    const proposal = compile(workspace);
    const expected = createHash('sha256').update(canonicalJson({
      manifest: proposal.manifest,
      files: proposal.files,
    })).digest('hex');
    assert.equal(proposal.hash, expected);
    assert.equal(
      proposal.files.every(({ path }) => path.endsWith('.sql')),
      true,
      'the evidence is generated SQL, not executed database state',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
