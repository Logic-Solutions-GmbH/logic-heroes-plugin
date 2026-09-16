/**
 * Dataset manifest — the user's own declaration of the shape of one dataset.
 *
 * The rate book (see `rate-profile.ts`) is one dataset with a semantic contract
 * the harness owns end to end. A user dataset has no such contract: the harness
 * cannot know the fields in advance, so the user declares them here, once, in a
 * versioned manifest. The manifest names the fields and their types, the
 * identity and deduplication keys, the indexes, the filters the harness may
 * offer, the provenance and approval fields, and an optional deterministic
 * selection policy.
 *
 * This module only parses and validates. It never opens a store, never emits
 * SQL and never writes: an unsupported or internally inconsistent declaration
 * has to be refused *before* any write, while a refusal still costs nothing.
 * Every refusal names the field, index, filter or role that failed, because a
 * refusal the user cannot act on is not a refusal worth having.
 */

export const DATASET_MANIFEST_VERSION = '1.0' as const;

/** The closed set of column types the harness can carry to a store. */
export const DATASET_FIELD_TYPES = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'timestamp',
  'json',
] as const;

/** The closed set of comparisons a declared filter may offer. */
export const DATASET_FILTER_OPERATORS = ['equals', 'one-of', 'range'] as const;

/** Provenance answers "where did this row come from", and all three are required. */
export const DATASET_PROVENANCE_ROLES = ['sourceFile', 'sourceRef', 'sourceHash'] as const;

/** Approval answers "who accepted this row, and for which content". */
export const DATASET_APPROVAL_ROLES = ['status', 'approvedBy', 'approvedAt', 'contentHash'] as const;

export type DatasetFieldType = typeof DATASET_FIELD_TYPES[number];
export type DatasetFilterOperator = typeof DATASET_FILTER_OPERATORS[number];
export type DatasetProvenanceRole = typeof DATASET_PROVENANCE_ROLES[number];
export type DatasetApprovalRole = typeof DATASET_APPROVAL_ROLES[number];

export interface DatasetField {
  name: string;
  type: DatasetFieldType;
  required: boolean;
}

export interface DatasetIndex {
  name: string;
  fields: string[];
  unique: boolean;
}

export interface DatasetFilter {
  field: string;
  operators: DatasetFilterOperator[];
}

export interface DatasetSelectionOrder {
  field: string;
  direction: 'asc' | 'desc';
}

export interface DatasetSelection {
  orderBy: DatasetSelectionOrder[];
  limit: number;
}

export interface DatasetManifest {
  schemaVersion: typeof DATASET_MANIFEST_VERSION;
  dataset: string;
  fields: DatasetField[];
  identity: string[];
  deduplication: string[];
  indexes: DatasetIndex[];
  filters: DatasetFilter[];
  provenance: Record<DatasetProvenanceRole, string>;
  approval: Record<DatasetApprovalRole, string>;
  selection?: DatasetSelection;
}

/** A field, index or dataset segment name the harness can carry into SQL unquoted. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const DATASET_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function parseDatasetManifest(value: unknown): DatasetManifest {
  const source = record(value, 'dataset manifest');
  if (source.schemaVersion !== DATASET_MANIFEST_VERSION) {
    throw new Error(`Unsupported dataset manifest version: ${String(source.schemaVersion)}`);
  }
  const dataset = text(source.dataset, 'dataset');
  if (!DATASET_KEY.test(dataset)) throw new Error(`Invalid dataset key: ${dataset}`);

  const fields = parseFields(source.fields);
  const fieldNames = new Set(fields.map(({ name }) => name));
  const identity = parseKey(source.identity, 'identity', fieldNames);
  const deduplication = parseKey(source.deduplication, 'deduplication', fieldNames);
  const indexes = parseIndexes(source.indexes, fieldNames);
  const filters = parseFilters(source.filters, fieldNames);
  const provenance = parseRoles(source.provenance, 'provenance', DATASET_PROVENANCE_ROLES, fieldNames);
  const approval = parseRoles(source.approval, 'approval', DATASET_APPROVAL_ROLES, fieldNames);
  const selection = parseSelection(source.selection, fieldNames, identity);

  const manifest: DatasetManifest = {
    schemaVersion: DATASET_MANIFEST_VERSION,
    dataset,
    fields,
    identity,
    deduplication,
    indexes,
    filters,
    provenance,
    approval,
  };
  if (selection) manifest.selection = selection;
  return manifest;
}

function parseFields(value: unknown): DatasetField[] {
  if (!Array.isArray(value)) throw new Error('fields must be an array');
  if (value.length === 0) throw new Error('fields must declare at least one field');
  const fields = value.map((item, index) => {
    const source = record(item, `fields[${index}]`);
    const name = text(source.name, `fields[${index}].name`);
    if (!IDENTIFIER.test(name)) throw new Error(`Invalid field name: ${name}`);
    const type = text(source.type, `fields[${index}].type`);
    if (!DATASET_FIELD_TYPES.includes(type as DatasetFieldType)) {
      throw new Error(`Unsupported field type for ${name}: ${type}`);
    }
    return { name, type: type as DatasetFieldType, required: flag(source.required, `fields[${index}].required`) };
  });
  noDuplicates(fields.map(({ name }) => name), 'field');
  return fields;
}

function parseKey(value: unknown, label: string, fieldNames: Set<string>): string[] {
  const key = strings(value, `${label} key`);
  if (key.length === 0) throw new Error(`${label} key must name at least one field`);
  noDuplicates(key, `field in the ${label} key`);
  for (const name of key) {
    if (!fieldNames.has(name)) throw new Error(`${label} key uses unknown field: ${name}`);
  }
  return key;
}

function parseIndexes(value: unknown, fieldNames: Set<string>): DatasetIndex[] {
  if (!Array.isArray(value)) throw new Error('indexes must be an array');
  const indexes = value.map((item, index) => {
    const source = record(item, `indexes[${index}]`);
    const name = text(source.name, `indexes[${index}].name`);
    if (!IDENTIFIER.test(name)) throw new Error(`Invalid index name: ${name}`);
    const fields = strings(source.fields, `indexes[${index}].fields`);
    if (fields.length === 0) throw new Error(`Index ${name} must name at least one field`);
    noDuplicates(fields, `field in index ${name}`);
    for (const field of fields) {
      if (!fieldNames.has(field)) throw new Error(`Index ${name} uses unknown field: ${field}`);
    }
    return { name, fields, unique: flag(source.unique, `indexes[${index}].unique`) };
  });
  noDuplicates(indexes.map(({ name }) => name), 'index');
  return indexes;
}

function parseFilters(value: unknown, fieldNames: Set<string>): DatasetFilter[] {
  if (!Array.isArray(value)) throw new Error('filters must be an array');
  const filters = value.map((item, index) => {
    const source = record(item, `filters[${index}]`);
    const field = text(source.field, `filters[${index}].field`);
    if (!fieldNames.has(field)) throw new Error(`Filter uses unknown field: ${field}`);
    const operators = strings(source.operators, `filters[${index}].operators`);
    if (operators.length === 0) throw new Error(`Filter on ${field} must allow at least one operator`);
    noDuplicates(operators, `operator on the filter over ${field}`);
    for (const operator of operators) {
      if (!DATASET_FILTER_OPERATORS.includes(operator as DatasetFilterOperator)) {
        throw new Error(`Unsupported filter operator on ${field}: ${operator}`);
      }
    }
    return { field, operators: operators as DatasetFilterOperator[] };
  });
  noDuplicates(filters.map(({ field }) => field), 'filter field');
  return filters;
}

function parseRoles<Role extends string>(
  value: unknown,
  label: string,
  roles: readonly Role[],
  fieldNames: Set<string>,
): Record<Role, string> {
  const source = record(value, `${label} declaration`);
  for (const declared of Object.keys(source)) {
    if (!roles.includes(declared as Role)) {
      throw new Error(`${label} declaration has an unsupported role: ${declared}`);
    }
  }
  const mapped = {} as Record<Role, string>;
  for (const role of roles) {
    if (source[role] === undefined) throw new Error(`${label} declaration is missing a field for: ${role}`);
    const field = text(source[role], `${label}.${role}`);
    if (!fieldNames.has(field)) throw new Error(`${label} field for ${role} is unknown: ${field}`);
    mapped[role] = field;
  }
  noDuplicates(roles.map((role) => mapped[role]), `${label} field`);
  return mapped;
}

/**
 * The selection policy is optional, but "deterministic" is not a decoration: a
 * policy that can return two different rows for one query is worse than none.
 * An order is total only when it ends on a key that is unique, so every
 * identity field has to take part in the order.
 */
function parseSelection(
  value: unknown,
  fieldNames: Set<string>,
  identity: string[],
): DatasetSelection | undefined {
  if (value === undefined) return undefined;
  const source = record(value, 'selection policy');
  if (!Array.isArray(source.orderBy)) throw new Error('selection policy orderBy must be an array');
  if (source.orderBy.length === 0) throw new Error('selection policy must order by at least one field');
  const orderBy = source.orderBy.map((item, index): DatasetSelectionOrder => {
    const order = record(item, `selection.orderBy[${index}]`);
    const field = text(order.field, `selection.orderBy[${index}].field`);
    if (!fieldNames.has(field)) throw new Error(`selection policy orders by unknown field: ${field}`);
    const direction = text(order.direction, `selection.orderBy[${index}].direction`);
    if (direction === 'asc' || direction === 'desc') return { field, direction };
    throw new Error(`selection policy has an unsupported order direction for ${field}: ${direction}`);
  });
  noDuplicates(orderBy.map(({ field }) => field), 'field in the selection order');
  const ordered = new Set(orderBy.map(({ field }) => field));
  for (const name of identity) {
    if (!ordered.has(name)) {
      throw new Error(`selection policy is not deterministic, it does not order by identity field: ${name}`);
    }
  }
  const limit = source.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new Error('selection policy limit must be an integer of at least 1');
  }
  return { orderBy, limit };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`);
  return value;
}

function noDuplicates(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
