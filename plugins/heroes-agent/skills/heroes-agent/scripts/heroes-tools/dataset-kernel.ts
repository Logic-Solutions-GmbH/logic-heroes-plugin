import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseDatasetManifest, type DatasetField, type DatasetManifest } from './dataset-manifest';
import type { DatasetRow, DatasetStore, StoredDataset } from './dataset-store';
import { objectsToCsv } from './lib';

export type DatasetQuery =
  | { field: string; operator: 'equals'; value: unknown }
  | { field: string; operator: 'one-of'; value: unknown[] }
  | { field: string; operator: 'range'; value: { from?: unknown; to?: unknown } };

export interface DatasetKernel {
  defineDataset(manifest: unknown): Promise<void>;
  ingest(datasetId: string, rows: DatasetRow[]): Promise<{ inserted: number; total: number }>;
  query(datasetId: string, query: DatasetQuery): Promise<DatasetRow[]>;
  export(datasetId: string): Promise<string>;
}

function datasetSnapshot(value: StoredDataset, datasetId: string): StoredDataset {
  const manifest = parseDatasetManifest(value.manifest);
  if (manifest.dataset !== datasetId) {
    throw new Error(`Stored dataset key does not match ${datasetId}: ${manifest.dataset}`);
  }
  if (!Array.isArray(value.rows)) throw new Error(`Stored dataset rows must be an array: ${datasetId}`);
  return { manifest, rows: validateRows(manifest, value.rows) };
}

async function requireDataset(store: DatasetStore, datasetId: string): Promise<StoredDataset> {
  const dataset = await store.read(datasetId);
  if (!dataset) throw new Error(`Dataset is not defined: ${datasetId}`);
  return datasetSnapshot(dataset, datasetId);
}

function empty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((item) => validJson(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function validValue(field: DatasetField, value: unknown): boolean {
  switch (field.type) {
    case 'text': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'decimal': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'date': return typeof value === 'string' && validDate(value);
    case 'timestamp': return typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && !Number.isNaN(Date.parse(value));
    case 'json': return validJson(value);
  }
}

function validateValue(field: DatasetField, value: unknown, label: string): void {
  if (empty(value)) {
    if (field.required) throw new Error(`${label} is required`);
    return;
  }
  if (!validValue(field, value)) throw new Error(`${label} must have type ${field.type}`);
}

function validateRows(manifest: DatasetManifest, rows: DatasetRow[]): DatasetRow[] {
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  const fields = new Map(manifest.fields.map((field) => [field.name, field]));
  return rows.map((source, offset) => {
    const rowNumber = offset + 1;
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`row ${rowNumber} must be an object`);
    }
    for (const name of Object.keys(source)) {
      if (!fields.has(name)) throw new Error(`row ${rowNumber} field ${name} is not declared`);
    }
    for (const field of manifest.fields) {
      validateValue(field, source[field.name], `row ${rowNumber} field ${field.name}`);
    }
    return structuredClone(source);
  });
}

function sameKey(left: DatasetRow, right: DatasetRow, fields: string[]): boolean {
  // Keys stay representation-sensitive; value equality applies to row content and filters.
  return fields.every((field) => isDeepStrictEqual(left[field], right[field]));
}

function describeKey(row: DatasetRow, fields: string[]): string {
  return fields.map((field) => `${field}=${String(row[field])}`).join(',');
}

function sameValue(field: DatasetField, left: unknown, right: unknown): boolean {
  if (field.type === 'timestamp') return Date.parse(String(left)) === Date.parse(String(right));
  return isDeepStrictEqual(left, right);
}

function firstChangedField(manifest: DatasetManifest, left: DatasetRow, right: DatasetRow): string | undefined {
  return manifest.fields.find((field) => {
    if (empty(left[field.name]) && empty(right[field.name])) return false;
    return !sameValue(field, left[field.name], right[field.name]);
  })?.name;
}

function collision(
  rows: DatasetRow[], candidate: DatasetRow, fields: string[], excludedIdentity: string[],
): DatasetRow | undefined {
  return rows.find((row) => !sameKey(row, candidate, excludedIdentity) && sameKey(row, candidate, fields));
}

function compare(field: DatasetField, left: unknown, right: unknown): number {
  if (field.type === 'timestamp') return Date.parse(String(left)) - Date.parse(String(right));
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function matches(row: DatasetRow, query: DatasetQuery, field: DatasetField): boolean {
  const actual = row[query.field];
  if (empty(actual)) return false;
  if (query.operator === 'equals') return sameValue(field, actual, query.value);
  if (query.operator === 'one-of') return query.value.some((value) => sameValue(field, actual, value));
  const lower = query.value.from;
  const upper = query.value.to;
  return (lower === undefined || compare(field, actual, lower) >= 0)
    && (upper === undefined || compare(field, actual, upper) <= 0);
}

function validateQueryValue(field: DatasetField, value: unknown, label: string): void {
  if (empty(value)) throw new Error(`${label} must not be empty`);
  validateValue(field, value, label);
}

function validateQuery(manifest: DatasetManifest, query: DatasetQuery): void {
  const declared = manifest.filters.find(({ field }) => field === query.field);
  if (!declared) throw new Error(`undeclared filter field: ${query.field}`);
  if (!declared.operators.includes(query.operator)) {
    throw new Error(`undeclared operator for ${query.field}: ${query.operator}`);
  }
  const field = manifest.fields.find(({ name }) => name === query.field)!;
  if (query.operator === 'one-of') {
    if (!Array.isArray(query.value) || query.value.length === 0) {
      throw new Error(`filter ${query.field} one-of value must be a non-empty array`);
    }
    query.value.forEach((value, index) => {
      validateQueryValue(field, value, `filter ${query.field} value ${index + 1}`);
    });
    return;
  }
  if (query.operator === 'range') {
    if (query.value === null || typeof query.value !== 'object' || Array.isArray(query.value)) {
      throw new Error(`filter ${query.field} range must be an object`);
    }
    const keys = Object.keys(query.value);
    if (keys.length === 0 || keys.some((key) => key !== 'from' && key !== 'to')) {
      throw new Error(`filter ${query.field} range must declare from or to`);
    }
    if ('from' in query.value) validateQueryValue(field, query.value.from, `filter ${query.field} from`);
    if ('to' in query.value) validateQueryValue(field, query.value.to, `filter ${query.field} to`);
    return;
  }
  validateQueryValue(field, query.value, `filter ${query.field} value`);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exportRows(manifest: DatasetManifest, rows: DatasetRow[]): DatasetRow[] {
  const jsonFields = new Set(manifest.fields.filter(({ type }) => type === 'json').map(({ name }) => name));
  return [...rows]
    .sort((left, right) => {
      for (const field of manifest.identity) {
        const declaration = manifest.fields.find(({ name }) => name === field)!;
        const order = compare(declaration, left[field], right[field]);
        if (order !== 0) return order;
      }
      return 0;
    })
    .map((row) => Object.fromEntries(manifest.fields.map(({ name }) => [
      name, jsonFields.has(name) && row[name] !== undefined ? canonicalJson(row[name]) : row[name],
    ])));
}

/** Build the public dataset API over one adapter. */
export function createDatasetKernel(store: DatasetStore): DatasetKernel {
  return {
    async defineDataset(input) {
      const manifest = parseDatasetManifest(input);
      const existing = await store.read(manifest.dataset);
      if (existing) {
        const current = datasetSnapshot(existing, manifest.dataset);
        if (!isDeepStrictEqual(current.manifest, manifest)) {
          throw new Error(`Dataset is already defined with a different manifest: ${manifest.dataset}`);
        }
        return;
      }
      await store.commit({ manifest, rows: [] });
    },

    async ingest(datasetId, inputRows) {
      const dataset = await requireDataset(store, datasetId);
      const incoming = validateRows(dataset.manifest, inputRows);
      const rows = structuredClone(dataset.rows);
      let inserted = 0;

      for (let index = 0; index < incoming.length; index++) {
        const candidate = incoming[index];
        const rowNumber = index + 1;
        const existing = rows.find((row) => sameKey(row, candidate, dataset.manifest.identity));
        if (existing) {
          const changed = firstChangedField(dataset.manifest, existing, candidate);
          if (changed) {
            throw new Error(
              `row ${rowNumber} identity ${describeKey(candidate, dataset.manifest.identity)} changed field ${changed}`,
            );
          }
          continue;
        }

        const duplicate = collision(rows, candidate, dataset.manifest.deduplication, dataset.manifest.identity);
        if (duplicate) {
          const key = describeKey(candidate, dataset.manifest.deduplication);
          throw new Error(`row ${rowNumber} deduplication key ${key} conflicts with an existing row`);
        }
        for (const unique of dataset.manifest.indexes.filter(({ unique }) => unique)) {
          if (collision(rows, candidate, unique.fields, dataset.manifest.identity)) {
            const key = describeKey(candidate, unique.fields);
            throw new Error(`row ${rowNumber} unique index ${unique.name} key ${key} conflicts with an existing row`);
          }
        }
        rows.push(candidate);
        inserted++;
      }

      if (inserted > 0) await store.commit({ manifest: dataset.manifest, rows });
      return { inserted, total: rows.length };
    },

    async query(datasetId, query) {
      const dataset = await requireDataset(store, datasetId);
      validateQuery(dataset.manifest, query);
      const field = dataset.manifest.fields.find(({ name }) => name === query.field)!;
      return structuredClone(dataset.rows.filter((row) => matches(row, query, field)));
    },

    async export(datasetId) {
      const dataset = await requireDataset(store, datasetId);
      const columns = dataset.manifest.fields.map(({ name }) => name);
      const csv = objectsToCsv(exportRows(dataset.manifest, dataset.rows), columns);
      const contentHash = createHash('sha256').update(csv).digest('hex');
      return store.writeExport(datasetId, contentHash, csv);
    },
  };
}
