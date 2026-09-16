import assert from 'node:assert/strict';
import test from 'node:test';
import { DATASET_MANIFEST_VERSION, parseDatasetManifest } from '../dataset-manifest';

/**
 * One minimal manifest that is valid in every respect, built fresh for each
 * case so a planted violation can never leak into the next one.
 */
function validManifest(): any {
  return {
    schemaVersion: DATASET_MANIFEST_VERSION,
    dataset: 'acme.customs_tariffs',
    fields: [
      { name: 'tariff_id', type: 'text', required: true },
      { name: 'hs_code', type: 'text', required: true },
      { name: 'duty_rate', type: 'decimal', required: true },
      { name: 'valid_from', type: 'date', required: true },
      { name: 'source_file', type: 'text', required: true },
      { name: 'source_ref', type: 'text', required: true },
      { name: 'source_hash', type: 'text', required: true },
      { name: 'approval_status', type: 'text', required: true },
      { name: 'approved_by', type: 'text', required: false },
      { name: 'approved_at', type: 'timestamp', required: false },
      { name: 'content_hash', type: 'text', required: true },
    ],
    identity: ['tariff_id'],
    deduplication: ['hs_code', 'valid_from', 'source_hash'],
    indexes: [
      { name: 'by_hs_code', fields: ['hs_code', 'valid_from'], unique: false },
    ],
    filters: [
      { field: 'hs_code', operators: ['equals', 'one-of'] },
      { field: 'valid_from', operators: ['range'] },
    ],
    provenance: { sourceFile: 'source_file', sourceRef: 'source_ref', sourceHash: 'source_hash' },
    approval: {
      status: 'approval_status',
      approvedBy: 'approved_by',
      approvedAt: 'approved_at',
      contentHash: 'content_hash',
    },
    selection: {
      orderBy: [{ field: 'valid_from', direction: 'desc' }, { field: 'tariff_id', direction: 'asc' }],
      limit: 1,
    },
  };
}

function refuse(change: (manifest: any) => void): string {
  const manifest = validManifest();
  change(manifest);
  try {
    parseDatasetManifest(manifest);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

test('validates the dataset manifest before any write', () => {
  const manifest = parseDatasetManifest(validManifest());

  assert.equal(manifest.schemaVersion, '1.0');
  assert.equal(manifest.dataset, 'acme.customs_tariffs');
  assert.equal(manifest.fields.length, 11);
  assert.deepEqual(manifest.identity, ['tariff_id']);
  assert.deepEqual(manifest.deduplication, ['hs_code', 'valid_from', 'source_hash']);
  assert.deepEqual(manifest.indexes, [{ name: 'by_hs_code', fields: ['hs_code', 'valid_from'], unique: false }]);
  assert.deepEqual(manifest.filters[0], { field: 'hs_code', operators: ['equals', 'one-of'] });
  assert.equal(manifest.provenance.sourceHash, 'source_hash');
  assert.equal(manifest.approval.contentHash, 'content_hash');
  assert.equal(manifest.selection?.limit, 1);

  const cases: { name: string; change(manifest: any): void; message: RegExp }[] = [
    {
      name: 'an unknown type',
      change: (m) => m.fields[2].type = 'money',
      message: /^Unsupported field type for duty_rate: money$/,
    },
    {
      name: 'a missing identity field',
      change: (m) => m.identity = ['tariff_uid'],
      message: /^identity key uses unknown field: tariff_uid$/,
    },
    {
      name: 'a duplicate field',
      change: (m) => m.fields.push({ name: 'hs_code', type: 'text', required: false }),
      message: /^Duplicate field: hs_code$/,
    },
    {
      name: 'a filter over an unknown field',
      change: (m) => m.filters[1].field = 'valid_until',
      message: /^Filter uses unknown field: valid_until$/,
    },
    {
      name: 'an index over an unknown field',
      change: (m) => m.indexes[0].fields = ['hs_code', 'chapter'],
      message: /^Index by_hs_code uses unknown field: chapter$/,
    },
    {
      name: 'an incomplete provenance declaration',
      change: (m) => delete m.provenance.sourceHash,
      message: /^provenance declaration is missing a field for: sourceHash$/,
    },
    {
      name: 'an incomplete approval declaration',
      change: (m) => delete m.approval.contentHash,
      message: /^approval declaration is missing a field for: contentHash$/,
    },
  ];

  for (const { name, change, message } of cases) {
    const refusal = refuse(change);
    assert.notEqual(refusal, '', `${name} was accepted`);
    assert.match(refusal, message, `${name} was refused without naming what failed`);
  }
});

test('refuses a selection policy that cannot answer the same query twice', () => {
  // The order stops before the identity field, so two rows can tie for first.
  assert.match(
    refuse((m) => m.selection.orderBy = [{ field: 'valid_from', direction: 'desc' }]),
    /^selection policy is not deterministic, it does not order by identity field: tariff_id$/,
  );
  assert.match(
    refuse((m) => m.selection.orderBy[0].direction = 'descending'),
    /^selection policy has an unsupported order direction for valid_from: descending$/,
  );
  assert.match(
    refuse((m) => m.selection.limit = 0),
    /^selection policy limit must be an integer of at least 1$/,
  );

  // The policy is optional. A manifest without one stays valid.
  const manifest = validManifest();
  delete manifest.selection;
  assert.equal(parseDatasetManifest(manifest).selection, undefined);
});

test('refuses an unsupported dataset manifest version', () => {
  assert.match(
    refuse((m) => m.schemaVersion = '2.0'),
    /^Unsupported dataset manifest version: 2\.0$/,
  );
  assert.match(
    refuse((m) => delete m.schemaVersion),
    /^Unsupported dataset manifest version: undefined$/,
  );
});
