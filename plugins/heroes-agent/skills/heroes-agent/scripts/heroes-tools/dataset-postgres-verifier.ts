import { createHash } from 'node:crypto';
import { parseDatasetManifest, type DatasetManifest } from './dataset-manifest';

export const DATASET_VERIFICATION_FIELDS = [
  'columns', 'uniqueKeys', 'indexes', 'rls', 'tenantPolicy', 'grants', 'functions',
] as const;

export type DatasetVerificationField = typeof DATASET_VERIFICATION_FIELDS[number];
export type DatasetVerification = Record<DatasetVerificationField, boolean>;

const SQL_TYPES: Record<DatasetManifest['fields'][number]['type'], string> = {
  text: 'text',
  integer: 'bigint',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamp with time zone',
  json: 'jsonb',
};

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
  return dataset.replaceAll('.', '__');
}

function textArray(values: string[]): string {
  return `array[${values.map(literal).join(', ')}]::text[]`;
}

function keyCheck(table: string, name: string, fields: string[]): string {
  return `exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = pg_catalog.to_regclass(${literal(`heroes_agent_datasets.${table}`)})
      and constraint_row.contype = 'u'
      and constraint_row.conname = ${literal(name)}
      and (
        select array_agg(attribute.attname::text order by key_column.ordinality)
        from unnest(constraint_row.conkey) with ordinality as key_column(attnum, ordinality)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = constraint_row.conrelid
         and attribute.attnum = key_column.attnum
      ) = ${textArray(fields)}
  )`;
}

function indexCheck(table: string, name: string, fields: string[], unique: boolean): string {
  return `exists (
    select 1
    from pg_catalog.pg_class index_class
    join pg_catalog.pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
    join pg_catalog.pg_index index_row on index_row.indexrelid = index_class.oid
    where index_namespace.nspname = 'heroes_agent_datasets'
      and index_class.relname = ${literal(name)}
      and index_row.indrelid = pg_catalog.to_regclass(${literal(`heroes_agent_datasets.${table}`)})
      and index_row.indisunique = ${unique ? 'true' : 'false'}
      and (
        select array_agg(attribute.attname::text order by index_column.ordinality)
        from unnest(index_row.indkey::smallint[]) with ordinality as index_column(attnum, ordinality)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_row.indrelid
         and attribute.attnum = index_column.attnum
      ) = ${textArray(fields)}
  )`;
}

/** Build one read-only catalog query that checks every object generated for a dataset. */
export function buildDatasetPostgresVerificationQuery(
  manifestInput: unknown,
  tenantKey: string,
): string {
  const manifest = parseDatasetManifest(manifestInput);
  const table = tableName(manifest.dataset);
  const target = `heroes_agent_datasets.${table}`;
  const role = `heroes_agent_${tenantKey}`;
  const ingest = derivedIdentifier('ingest', table);
  const query = derivedIdentifier('query', table);
  const tenantExpression = `(tenant_key = '${tenantKey}'::text)`;
  const expectedColumns = [
    { name: 'tenant_key', type: 'text', required: true },
    ...manifest.fields.map((field) => ({
      name: field.name, type: SQL_TYPES[field.type], required: field.required,
    })),
  ];
  const columnValues = expectedColumns.map((column, index) => (
    `(${index + 1}, ${literal(column.name)}, ${literal(column.type)}, ${column.required ? 'true' : 'false'})`
  )).join(',\n    ');
  const identityName = derivedIdentifier(table, 'identity', 'key');
  const deduplicationName = derivedIdentifier(table, 'deduplication', 'key');
  const uniqueKeys = [
    keyCheck(table, identityName, manifest.identity),
    keyCheck(table, deduplicationName, manifest.deduplication),
  ].join('\n  and ');
  const indexes = manifest.indexes.length
    ? manifest.indexes.map((index) => indexCheck(
      table, index.name, index.fields, index.unique,
    )).join('\n  and ')
    : 'true';

  return String.raw`/* dataset_catalog_verification */
with expected_columns(ordinal_position, name, formatted_type, required) as (
  values
    ${columnValues}
), actual_columns as (
  select attribute.attnum as ordinal_position,
    attribute.attname::text as name,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as formatted_type,
    attribute.attnotnull as required
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid = pg_catalog.to_regclass(${literal(target)})
    and attribute.attnum > 0
    and not attribute.attisdropped
)
select jsonb_build_object(
  'columns',
    (select count(*) from expected_columns) = (select count(*) from actual_columns)
    and not exists (
      select 1 from expected_columns expected
      left join actual_columns actual using (ordinal_position, name, formatted_type, required)
      where actual.name is null
    ),
  'uniqueKeys',
    ${uniqueKeys},
  'indexes',
    ${indexes},
  'rls', exists (
    select 1
    from pg_catalog.pg_class relation
    where relation.oid = pg_catalog.to_regclass(${literal(target)})
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ),
  'tenantPolicy', (
    select count(*) = 1
      and bool_and(policy.polname = ${literal(derivedIdentifier(table, 'tenant'))})
      and bool_and(policy.polpermissive)
      and bool_and(policy.polcmd = '*')
      and bool_and(policy.polroles = array[(select oid from pg_catalog.pg_roles where rolname = ${literal(role)})])
      and bool_and(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = ${literal(tenantExpression)})
      and bool_and(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = ${literal(tenantExpression)})
    from pg_catalog.pg_policy policy
    where policy.polrelid = pg_catalog.to_regclass(${literal(target)})
  ),
  'grants', case
    when pg_catalog.to_regnamespace('heroes_agent_datasets') is null
      or pg_catalog.to_regclass(${literal(target)}) is null
    then false
    else exists (
      select 1
      from pg_catalog.pg_roles tenant_role
      where tenant_role.rolname = ${literal(role)}
        and not tenant_role.rolsuper
        and not tenant_role.rolcreatedb
        and not tenant_role.rolcreaterole
        and not tenant_role.rolcanlogin
        and not tenant_role.rolreplication
        and not tenant_role.rolbypassrls
    )
      and (
        select count(*) = 1
          and bool_and(member_role.rolname = 'postgres')
          and bool_and(membership.admin_option)
          and bool_and(not membership.inherit_option)
          and bool_and(not membership.set_option)
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles tenant_role
          on tenant_role.rolname = ${literal(role)}
         and membership.roleid = tenant_role.oid
        join pg_catalog.pg_roles member_role on member_role.oid = membership.member
      )
      and not exists (
        select 1
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles tenant_role
          on tenant_role.rolname = ${literal(role)}
         and membership.member = tenant_role.oid
      )
      and has_schema_privilege(${literal(role)}, 'heroes_agent_datasets', 'USAGE')
      and not has_schema_privilege(${literal(role)}, 'heroes_agent_datasets', 'CREATE')
      and has_table_privilege(${literal(role)}, ${literal(target)}, 'SELECT')
      and has_table_privilege(${literal(role)}, ${literal(target)}, 'INSERT')
      and has_table_privilege(${literal(role)}, ${literal(target)}, 'UPDATE')
      and has_table_privilege(${literal(role)}, ${literal(target)}, 'DELETE')
      and not has_table_privilege(${literal(role)}, ${literal(target)}, 'TRUNCATE')
      and not has_table_privilege(${literal(role)}, ${literal(target)}, 'REFERENCES')
      and not has_table_privilege(${literal(role)}, ${literal(target)}, 'TRIGGER')
      and not has_schema_privilege('anon', 'heroes_agent_datasets', 'USAGE')
      and not has_schema_privilege('authenticated', 'heroes_agent_datasets', 'USAGE')
      and not has_table_privilege('anon', ${literal(target)}, 'SELECT')
      and not has_table_privilege('authenticated', ${literal(target)}, 'SELECT')
      and not exists (
        select 1
        from pg_catalog.pg_namespace namespace_row
        cross join lateral pg_catalog.aclexplode(
          coalesce(namespace_row.nspacl, pg_catalog.acldefault('n'::"char", namespace_row.nspowner))
        ) access_row
        where namespace_row.nspname = 'heroes_agent_datasets'
          and (
            access_row.grantee not in (
              namespace_row.nspowner,
              (select oid from pg_catalog.pg_roles where rolname = ${literal(role)})
            )
            or (
              access_row.grantee = (select oid from pg_catalog.pg_roles where rolname = ${literal(role)})
              and (access_row.privilege_type <> 'USAGE' or access_row.is_grantable)
            )
          )
      )
      and not exists (
        select 1
        from pg_catalog.pg_class relation
        cross join lateral pg_catalog.aclexplode(
          coalesce(relation.relacl, pg_catalog.acldefault('r'::"char", relation.relowner))
        ) access_row
        where relation.oid = pg_catalog.to_regclass(${literal(target)})
          and (
            access_row.grantee not in (
              relation.relowner,
              (select oid from pg_catalog.pg_roles where rolname = ${literal(role)})
            )
            or (
              access_row.grantee = (select oid from pg_catalog.pg_roles where rolname = ${literal(role)})
              and (
                access_row.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
                or access_row.is_grantable
              )
            )
          )
      )
      and not exists (
        select 1
        from pg_catalog.pg_attribute attribute
        cross join lateral pg_catalog.aclexplode(attribute.attacl) access_row
        where attribute.attrelid = pg_catalog.to_regclass(${literal(target)})
          and attribute.attnum > 0
          and not attribute.attisdropped
      )
  end,
  'functions', (
    select count(*) = 2
      and bool_and(not procedure.prosecdef)
      and bool_and(pg_catalog.oidvectortypes(procedure.proargtypes) = 'jsonb')
      and bool_and(coalesce(
        procedure.proconfig @> array['search_path=pg_catalog, heroes_agent_datasets'],
        false
      ))
      and bool_and(has_function_privilege(${literal(role)}, procedure.oid, 'EXECUTE'))
      and bool_and(not has_function_privilege('anon', procedure.oid, 'EXECUTE'))
      and bool_and(not has_function_privilege('authenticated', procedure.oid, 'EXECUTE'))
      and bool_and(not exists (
        select 1
        from pg_catalog.aclexplode(
          coalesce(procedure.proacl, pg_catalog.acldefault('f'::"char", procedure.proowner))
        ) access_row
        where access_row.grantee not in (
            procedure.proowner,
            (select oid from pg_catalog.pg_roles where rolname = ${literal(role)})
          )
          or (
            access_row.grantee = (select oid from pg_catalog.pg_roles where rolname = ${literal(role)})
            and (access_row.privilege_type <> 'EXECUTE' or access_row.is_grantable)
          )
      ))
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace procedure_namespace
      on procedure_namespace.oid = procedure.pronamespace
    where procedure_namespace.nspname = 'heroes_agent_datasets'
      and procedure.proname in (${literal(ingest)}, ${literal(query)})
      and (
        (procedure.proname = ${literal(ingest)} and procedure.prorettype = 'bigint'::regtype)
        or (procedure.proname = ${literal(query)} and procedure.prorettype = pg_catalog.to_regclass(${literal(target)}))
      )
  )
) as verification;
`;
}

export function readDatasetPostgresVerification(value: unknown): DatasetVerification {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object') {
    throw new Error('[verification_failed] Supabase verification result is invalid.');
  }
  const verification = (value[0] as Record<string, unknown>).verification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    throw new Error('[verification_failed] Supabase verification result is invalid.');
  }
  return Object.fromEntries(DATASET_VERIFICATION_FIELDS.map((field) => [
    field, (verification as Record<string, unknown>)[field] === true,
  ])) as DatasetVerification;
}

export function assertDatasetPostgresVerification(verification: DatasetVerification): void {
  const failed = DATASET_VERIFICATION_FIELDS.filter((field) => !verification[field]);
  if (failed.length) {
    throw new Error(`[verification_failed] Installed dataset model differs in: ${failed.join(', ')}.`);
  }
}
