import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatasetManifest } from './dataset-manifest';
import type { DatasetRow, DatasetStore } from './dataset-store';
import { openLocalDatasetStore } from './local-dataset-store';

export interface PostgresDatasetStoreOptions {
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>;
  workspace: string;
  manifest: DatasetManifest;
  tenantKey: string;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function derivedIdentifier(...parts: string[]): string {
  const name = parts.join('_');
  if (Buffer.byteLength(name, 'utf8') <= 63) return name;
  const suffix = `_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const prefixBytes = 63 - Buffer.byteLength(suffix, 'utf8');
  let prefix = '';
  for (const character of name) {
    if (Buffer.byteLength(prefix + character, 'utf8') > prefixBytes) break;
    prefix += character;
  }
  return `${prefix}${suffix}`;
}

function tableName(dataset: string): string {
  const name = dataset.replaceAll('.', '__');
  if (Buffer.byteLength(name, 'utf8') > 63) {
    throw new Error(`Dataset table name exceeds 63 characters: ${name}`);
  }
  return name;
}

function sqlJson(value: unknown): string {
  return `${literal(JSON.stringify(value))}::jsonb`;
}

/** Write PostgreSQL timestamps in UTC. The local adapter keeps the given text. */
function utcTimestampText(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const milliseconds = Date.parse(String(value));
  if (Number.isNaN(milliseconds)) return value;
  const iso = new Date(milliseconds).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

function asRow(value: unknown): DatasetRow {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as DatasetRow;
  }
  if (typeof value === 'string') return JSON.parse(value) as DatasetRow;
  throw new Error('PostgreSQL dataset row is not JSON');
}

function jsonTypedRow(manifest: DatasetManifest, value: unknown): DatasetRow {
  const row = asRow(value);
  return Object.fromEntries(manifest.fields.map((field) => [
    field.name,
    field.type === 'timestamp' ? utcTimestampText(row[field.name]) : row[field.name],
  ]));
}

/** Open a DatasetStore over one runQuery(sql) seam. The table must already exist. */
export function openPostgresDatasetStore(options: PostgresDatasetStoreOptions): DatasetStore {
  const { runQuery, workspace, manifest } = options;
  const schema = identifier('heroes_agent_datasets');
  const table = tableName(manifest.dataset);
  const ingest = `${schema}.${identifier(derivedIdentifier('ingest', table))}`;
  const query = `${schema}.${identifier(derivedIdentifier('query', table))}`;
  const local = openLocalDatasetStore(workspace);

  return {
    async read(datasetId) {
      if (datasetId !== manifest.dataset) return undefined;
      const result = await runQuery(
        `SELECT to_jsonb(${identifier('row')}) - 'tenant_key' AS ${identifier('row')}`
        + ` FROM ${query}('{}'::jsonb) AS ${identifier('row')}`,
      );
      return {
        manifest,
        rows: result.map((entry) => jsonTypedRow(manifest, entry.row)),
      };
    },

    async commit(dataset) {
      if (!isDeepStrictEqual(dataset.manifest, manifest)) {
        throw new Error(`Dataset is already defined with a different manifest: ${manifest.dataset}`);
      }
      await runQuery(`SELECT ${ingest}(${sqlJson(dataset.rows)}) AS inserted_count`);
    },

    async writeExport(datasetId, contentHash, csv) {
      return local.writeExport(datasetId, contentHash, csv);
    },
  };
}
