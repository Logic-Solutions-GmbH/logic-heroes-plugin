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

/** Adds a required `json` field that no key, index, filter or order uses. */
function withPayload(manifest: any): void {
  manifest.fields.push({ name: 'payload', type: 'json', required: true });
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
    // Names.
    { name: 'an invalid dataset key', change: (m) => m.dataset = 'Acme', message: /^Invalid dataset key: Acme$/ },
    { name: 'an invalid field name', change: (m) => m.fields[1].name = 'HS-Code', message: /^Invalid field name: HS-Code$/ },
    {
      name: 'a field name longer than 63 characters',
      change: (m) => m.fields.push({ name: 'a'.repeat(64), type: 'text', required: false }),
      message: new RegExp(`^Invalid field name: ${'a'.repeat(64)}$`),
    },
    { name: 'an invalid index name', change: (m) => m.indexes[0].name = 'By HS', message: /^Invalid index name: By HS$/ },
    // Shapes.
    { name: 'a field that is not an object', change: (m) => m.fields = [7], message: /^fields\[0\] must be an object$/ },
    { name: 'fields that are not an array', change: (m) => m.fields = {}, message: /^fields must be an array$/ },
    { name: 'no fields', change: (m) => m.fields = [], message: /^fields must declare at least one field$/ },
    { name: 'an empty field name', change: (m) => m.fields[1].name = ' ', message: /^fields\[1\]\.name must be a non-empty string$/ },
    { name: 'a required flag that is not a boolean', change: (m) => m.fields[1].required = 'yes', message: /^fields\[1\]\.required must be true or false$/ },
    { name: 'a key that is not a string array', change: (m) => m.identity = 'tariff_id', message: /^identity key must be an array of non-empty strings$/ },
    { name: 'indexes that are not an array', change: (m) => m.indexes = {}, message: /^indexes must be an array$/ },
    { name: 'filters that are not an array', change: (m) => m.filters = {}, message: /^filters must be an array$/ },
    // Keys.
    { name: 'an empty identity key', change: (m) => m.identity = [], message: /^identity key must name at least one field$/ },
    { name: 'an empty deduplication key', change: (m) => m.deduplication = [], message: /^deduplication key must name at least one field$/ },
    {
      name: 'a duplicate field in a key',
      change: (m) => m.identity = ['tariff_id', 'tariff_id'],
      message: /^Duplicate field in the identity key: tariff_id$/,
    },
    {
      name: 'an optional identity field',
      change: (m) => m.fields[0].required = false,
      message: /^identity field must be required: tariff_id$/,
    },
    {
      name: 'an optional deduplication field',
      change: (m) => m.fields[1].required = false,
      message: /^deduplication field must be required: hs_code$/,
    },
    {
      name: 'an optional field in a unique index',
      change: (m) => m.indexes.push({ name: 'by_approver', fields: ['approved_by'], unique: true }),
      message: /^unique index by_approver field must be required: approved_by$/,
    },
    // Indexes.
    { name: 'an index without fields', change: (m) => m.indexes[0].fields = [], message: /^Index by_hs_code must name at least one field$/ },
    {
      name: 'a duplicate field in an index',
      change: (m) => m.indexes[0].fields = ['hs_code', 'hs_code'],
      message: /^Duplicate field in index by_hs_code: hs_code$/,
    },
    {
      name: 'a duplicate index name',
      change: (m) => m.indexes.push({ name: 'by_hs_code', fields: ['valid_from'], unique: true }),
      message: /^Duplicate index: by_hs_code$/,
    },
    // Filters.
    { name: 'a filter without operators', change: (m) => m.filters[0].operators = [], message: /^Filter on hs_code must allow at least one operator$/ },
    {
      name: 'a duplicate operator',
      change: (m) => m.filters[0].operators = ['equals', 'equals'],
      message: /^Duplicate operator on the filter over hs_code: equals$/,
    },
    { name: 'an unknown operator', change: (m) => m.filters[0].operators = ['like'], message: /^Unsupported filter operator on hs_code: like$/ },
    {
      name: 'a duplicate filter field',
      change: (m) => m.filters.push({ field: 'hs_code', operators: ['equals'] }),
      message: /^Duplicate filter field: hs_code$/,
    },
    {
      name: 'a range filter on a boolean field',
      change: (m) => {
        m.fields.push({ name: 'is_active', type: 'boolean', required: true });
        m.filters.push({ field: 'is_active', operators: ['equals', 'range'] });
      },
      message: /^Filter on is_active cannot offer range on a boolean field$/,
    },
    // Roles.
    {
      name: 'an unknown provenance role',
      change: (m) => m.provenance.sourceUrl = 'source_ref',
      message: /^provenance declaration has an unsupported role: sourceUrl$/,
    },
    {
      name: 'one field in two provenance roles',
      change: (m) => m.provenance.sourceRef = 'source_file',
      message: /^Duplicate provenance field: source_file$/,
    },
    {
      name: 'a provenance role on an unknown field',
      change: (m) => m.provenance.sourceRef = 'source_url',
      message: /^provenance field for sourceRef is unknown: source_url$/,
    },
    {
      name: 'an optional provenance field',
      change: (m) => m.fields[6].required = false,
      message: /^provenance field for sourceHash must be required: source_hash$/,
    },
    // Selection.
    { name: 'an order that is not an array', change: (m) => m.selection.orderBy = {}, message: /^selection policy orderBy must be an array$/ },
    { name: 'an empty order', change: (m) => m.selection.orderBy = [], message: /^selection policy must order by at least one field$/ },
    {
      name: 'an order by an unknown field',
      change: (m) => m.selection.orderBy[0].field = 'valid_until',
      message: /^selection policy orders by unknown field: valid_until$/,
    },
    {
      name: 'a duplicate field in the order',
      change: (m) => m.selection.orderBy.push({ field: 'valid_from', direction: 'asc' }),
      message: /^Duplicate field in the selection order: valid_from$/,
    },
    // A json value has no equality and no order.
    ...(['identity', 'deduplication'] as const).map((key) => ({
      name: `a json field in the ${key} key`,
      change: (m: any) => { withPayload(m); m[key] = ['payload']; },
      message: new RegExp(`^${key} key cannot use json field: payload$`),
    })),
    {
      name: 'a json field in an index',
      change: (m) => { withPayload(m); m.indexes[0].fields = ['payload']; },
      message: /^Index by_hs_code cannot use json field: payload$/,
    },
    {
      name: 'a json field in a filter',
      change: (m) => { withPayload(m); m.filters[0].field = 'payload'; },
      message: /^Filter cannot use json field: payload$/,
    },
    {
      name: 'a json field in the order',
      change: (m) => { withPayload(m); m.selection.orderBy[0].field = 'payload'; },
      message: /^selection policy cannot order by json field: payload$/,
    },
    // A misspelled key must not drop its declaration without a word.
    { name: 'an unknown manifest key', change: (m) => m.selecton = m.selection, message: /^dataset manifest has an unknown key: selecton$/ },
    { name: 'an unknown field key', change: (m) => m.fields[0].nullable = false, message: /^fields\[0\] has an unknown key: nullable$/ },
    { name: 'an unknown index key', change: (m) => m.indexes[0].where = 'x', message: /^indexes\[0\] has an unknown key: where$/ },
    { name: 'an unknown filter key', change: (m) => m.filters[0].op = 'equals', message: /^filters\[0\] has an unknown key: op$/ },
    { name: 'an unknown selection key', change: (m) => m.selection.offset = 1, message: /^selection policy has an unknown key: offset$/ },
    {
      name: 'an unknown order key',
      change: (m) => m.selection.orderBy[0].nulls = 'first',
      message: /^selection\.orderBy\[0\] has an unknown key: nulls$/,
    },
  ];

  // Every case runs, so one broken guard cannot hide another.
  const problems: string[] = [];
  for (const { name, change, message } of cases) {
    const refusal = refuse(change);
    if (!refusal) problems.push(`${name} was accepted`);
    else if (!message.test(refusal)) problems.push(`${name} was refused with: ${refusal}`);
  }
  assert.deepEqual(problems, []);
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

test('accepts a json field, a boolean filter and a 63-character name where they are safe', () => {
  const source = validManifest();
  withPayload(source);
  source.fields.push({ name: 'is_active', type: 'boolean', required: true });
  source.fields.push({ name: 'a'.repeat(63), type: 'text', required: false });
  source.filters.push({ field: 'is_active', operators: ['equals'] });

  const manifest = parseDatasetManifest(source);
  assert.equal(manifest.fields.length, 14);
  assert.deepEqual(manifest.filters[2], { field: 'is_active', operators: ['equals'] });
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
