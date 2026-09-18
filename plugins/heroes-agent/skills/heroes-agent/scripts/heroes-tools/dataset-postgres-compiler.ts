import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseDatasetManifest, type DatasetField, type DatasetManifest } from './dataset-manifest';

export interface DatasetSqlFile {
  path: string;
  content: string;
}

export interface CompileDatasetPostgresOptions {
  manifest: unknown;
  tenantKey: string;
  migrationVersion: string;
}

const SQL_TYPES: Record<DatasetField['type'], string> = {
  text: 'text',
  integer: 'bigint',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
  json: 'jsonb',
};

const JSON_TYPES: Record<DatasetField['type'], string> = {
  text: 'string',
  integer: 'number',
  decimal: 'number',
  boolean: 'boolean',
  date: 'string',
  timestamp: 'string',
  json: 'object',
};

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

function tenantRoleName(tenantKey: string): string {
  const role = `heroes_agent_${tenantKey}`;
  if (Buffer.byteLength(role, 'utf8') > 63) {
    throw new Error(
      `Tenant key ${tenantKey} makes role ${role} exceed the PostgreSQL identifier limit of 63 bytes`,
    );
  }
  return role;
}

function tableName(dataset: string): string {
  const name = dataset.replaceAll('.', '__');
  if (Buffer.byteLength(name, 'utf8') > 63) {
    throw new Error(`Dataset table name exceeds 63 characters: ${name}`);
  }
  return name;
}

function commaList(names: string[]): string {
  return names.map(identifier).join(', ');
}

function schemaSql(manifest: DatasetManifest, table: string): string {
  const target = `${identifier('heroes_agent_datasets')}.${identifier(table)}`;
  const columns = manifest.fields.map((field) => (
    `  ${identifier(field.name)} ${SQL_TYPES[field.type]}${field.required ? ' NOT NULL' : ''}`
  ));
  const constraints = [
    `  CONSTRAINT ${identifier(derivedIdentifier(table, 'identity', 'key'))} UNIQUE (${commaList(manifest.identity)})`,
    `  CONSTRAINT ${identifier(derivedIdentifier(table, 'deduplication', 'key'))} UNIQUE (${commaList(manifest.deduplication)})`,
  ];
  const indexes = manifest.indexes.map((index) => (
    `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${identifier(index.name)} ON ${target} (${commaList(index.fields)});`
  ));

  return [
    `CREATE SCHEMA IF NOT EXISTS ${identifier('heroes_agent_datasets')};`,
    '',
    `CREATE TABLE ${target} (`,
    `  ${identifier('tenant_key')} text NOT NULL,`,
    [...columns, ...constraints].join(',\n'),
    ');',
    '',
    ...indexes,
    '',
  ].join('\n');
}

function rlsSql(table: string, tenantKey: string, roleName: string): string {
  const target = `${identifier('heroes_agent_datasets')}.${identifier(table)}`;
  const role = identifier(roleName);
  const tenantCheck = `${identifier('tenant_key')} = ${literal(tenantKey)}`;
  return [
    `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${target} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${identifier(derivedIdentifier(table, 'tenant'))} ON ${target}`,
    `  TO ${role}`,
    `  USING (${tenantCheck})`,
    `  WITH CHECK (${tenantCheck});`,
    `GRANT USAGE ON SCHEMA ${identifier('heroes_agent_datasets')} TO ${role};`,
    `REVOKE ALL PRIVILEGES ON TABLE ${target} FROM PUBLIC, ${identifier('anon')}, ${identifier('authenticated')};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${target} TO ${role};`,
    '',
  ].join('\n');
}

function castJson(expression: string, field: DatasetField): string {
  return field.type === 'json' ? expression : `(${expression})::${SQL_TYPES[field.type]}`;
}

function filterSql(manifest: DatasetManifest): string[] {
  return manifest.filters.map((filter) => {
    const field = manifest.fields.find(({ name }) => name === filter.field)!;
    const source = `${identifier('p_filters')} -> ${literal(filter.field)}`;
    const column = `${identifier('row')}.${identifier(filter.field)}`;
    const clauses: string[] = [];

    if (filter.operators.includes('equals')) {
      clauses.push(
        `(CASE WHEN jsonb_typeof(${source}) = '${JSON_TYPES[field.type]}' `
        + `THEN ${column} = ${castJson(`${source} #>> '{}'`, field)} ELSE false END)`,
      );
    }
    if (filter.operators.includes('one-of')) {
      clauses.push(`(CASE WHEN jsonb_typeof(${source}) = 'array' THEN EXISTS (`
        + `SELECT 1 FROM jsonb_array_elements(${source}) AS ${identifier('item')}(${identifier('value')}) `
        + `WHERE ${column} = ${castJson(`${identifier('item')}.${identifier('value')} #>> '{}'`, field)}`
        + ') ELSE false END)');
    }
    if (filter.operators.includes('range')) {
      clauses.push(`(CASE WHEN jsonb_typeof(${source}) = 'object' THEN `
        + `(NOT (${source} ? 'from') OR ${column} >= ${castJson(`${source} ->> 'from'`, field)})`
        + ` AND (NOT (${source} ? 'to') OR ${column} <= ${castJson(`${source} ->> 'to'`, field)})`
        + ' ELSE false END)');
    }
    return `  AND (NOT (${identifier('p_filters')} ? ${literal(filter.field)}) OR ${clauses.join(' OR ')})`;
  });
}

function functionsSql(manifest: DatasetManifest, table: string, tenantKey: string, roleName: string): string {
  const schema = identifier('heroes_agent_datasets');
  const target = `${schema}.${identifier(table)}`;
  const role = identifier(roleName);
  const fields = manifest.fields.map(({ name }) => name);
  const insertColumns = ['tenant_key', ...fields];
  const recordColumns = manifest.fields.map((field) => (
    `${identifier(field.name)} ${SQL_TYPES[field.type]}`
  ));
  const ingest = `${schema}.${identifier(derivedIdentifier('ingest', table))}`;
  const query = `${schema}.${identifier(derivedIdentifier('query', table))}`;

  return [
    `CREATE OR REPLACE FUNCTION ${ingest}(${identifier('p_rows')} jsonb)`,
    'RETURNS bigint',
    'LANGUAGE plpgsql',
    'SECURITY INVOKER',
    `SET search_path = pg_catalog, ${schema}`,
    'AS $function$',
    `DECLARE ${identifier('inserted_count')} bigint;`,
    'BEGIN',
    `  INSERT INTO ${target} (${commaList(insertColumns)})`,
    `  SELECT ${literal(tenantKey)}, ${fields.map((name) => `${identifier('source')}.${identifier(name)}`).join(', ')}`,
    `  FROM jsonb_to_recordset(${identifier('p_rows')}) AS ${identifier('source')}(${recordColumns.join(', ')});`,
    `  GET DIAGNOSTICS ${identifier('inserted_count')} = ROW_COUNT;`,
    `  RETURN ${identifier('inserted_count')};`,
    'END',
    '$function$;',
    '',
    `CREATE OR REPLACE FUNCTION ${query}(${identifier('p_filters')} jsonb)`,
    `RETURNS SETOF ${target}`,
    'LANGUAGE sql',
    'SECURITY INVOKER',
    `SET search_path = pg_catalog, ${schema}`,
    'AS $function$',
    `SELECT ${identifier('row')}.* FROM ${target} AS ${identifier('row')}`,
    `WHERE ${identifier('row')}.${identifier('tenant_key')} = ${literal(tenantKey)}`,
    ...filterSql(manifest),
    ';',
    '$function$;',
    '',
    `REVOKE ALL PRIVILEGES ON FUNCTION ${ingest}(jsonb) FROM PUBLIC, ${identifier('anon')}, ${identifier('authenticated')};`,
    `REVOKE ALL PRIVILEGES ON FUNCTION ${query}(jsonb) FROM PUBLIC, ${identifier('anon')}, ${identifier('authenticated')};`,
    `GRANT EXECUTE ON FUNCTION ${ingest}(jsonb) TO ${role};`,
    `GRANT EXECUTE ON FUNCTION ${query}(jsonb) TO ${role};`,
    '',
  ].join('\n');
}

/** Compile one valid manifest into deterministic PostgreSQL files without writing or executing SQL. */
export function compileDatasetPostgres(options: CompileDatasetPostgresOptions): {
  manifest: DatasetManifest;
  files: DatasetSqlFile[];
} {
  const manifest = parseDatasetManifest(options.manifest);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.tenantKey)) {
    throw new Error('Tenant key must be normalized lower-case hyphen-case.');
  }
  if (!/^\d+$/.test(options.migrationVersion)) {
    throw new Error(`Invalid migration version: ${options.migrationVersion}`);
  }
  const role = tenantRoleName(options.tenantKey);
  const table = tableName(manifest.dataset);
  const base = posix.join(
    'self', 'supabase', 'project', 'supabase', 'migrations', `${options.migrationVersion}_${table}`,
  );
  return {
    manifest,
    files: [
      { path: `${base}_schema.sql`, content: schemaSql(manifest, table) },
      { path: `${base}_rls.sql`, content: rlsSql(table, options.tenantKey, role) },
      { path: `${base}_functions.sql`, content: functionsSql(manifest, table, options.tenantKey, role) },
    ],
  };
}
