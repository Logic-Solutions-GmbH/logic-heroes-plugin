import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagString, parseArgs, run } from './lib';
import {
  loadConfirmedRateProfile, parseRateProfile, persistConfirmedRateProfile, type RateProfile,
} from './rate-profile';
import {
  applyPush, assertMigrationHistory, dryRunPush, failure, managementRequest, migrationRows,
  objectResult, prepareMigrations, requireCli, writeAttempt,
} from './supabase-dataset-store';

const PROJECT_REF = 'enjephpxfrbccskdljun';
const TENANT_KEY = 'acme';
const PROJECT_NAME = 'user-db';
const PROJECT_REGION = 'eu-west-1';
const RATE_MODEL_MIGRATION_VERSION = '20260912000100';
const RATE_MODEL_MIGRATION_FILE = `${RATE_MODEL_MIGRATION_VERSION}_acme_rate_model.sql`;
const TENANT_CONTEXT_MIGRATION_VERSION = '20260912000200';
const TENANT_CONTEXT_MIGRATION_FILE = `${TENANT_CONTEXT_MIGRATION_VERSION}_acme_rate_context_key.sql`;
const QUERY_CONTEXT_MIGRATION_VERSION = '20260912000300';
const QUERY_CONTEXT_MIGRATION_FILE = `${QUERY_CONTEXT_MIGRATION_VERSION}_acme_rate_query_context.sql`;
const toolsDir = dirname(fileURLToPath(import.meta.url));
const pluginSkillRoot = resolve(toolsDir, '..', '..');
const bootstrapProject = join(pluginSkillRoot, 'assets', 'supabase-project', 'supabase');
const rateMigrations = [
  RATE_MODEL_MIGRATION_FILE, TENANT_CONTEXT_MIGRATION_FILE, QUERY_CONTEXT_MIGRATION_FILE,
].map((file) => ({
  file,
  version: file.slice(0, 14),
  source: join(pluginSkillRoot, 'assets', 'supabase-rate-model', 'acme', 'migrations', file),
}));

interface Binding {
  schemaVersion: '1.0';
  heroesTenantKey: string;
  supabaseProjectRef: string;
  supabaseProjectName: string;
  supabaseRegion: string;
}

const METADATA_QUERY = String.raw`
with target_schemas as (
  select oid, nspname
  from pg_catalog.pg_namespace
  where nspname in ('heroes_agent_control', 'heroes_agent_rates')
)
select jsonb_build_object(
  'schemas', coalesce((
    select jsonb_agg(jsonb_build_object('name', nspname) order by nspname)
    from target_schemas
  ), '[]'::jsonb),
  'relations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'name', c.relname,
      'kind', case c.relkind when 'r' then 'table' when 'p' then 'partitioned-table' when 'v' then 'view' when 'm' then 'materialized-view' else c.relkind::text end,
      'rls_enabled', c.relrowsecurity,
      'rls_forced', c.relforcerowsecurity,
      'options', coalesce(to_jsonb(c.reloptions), '[]'::jsonb)
    ) order by n.nspname, c.relname)
    from pg_catalog.pg_class c
    join target_schemas n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm')
  ), '[]'::jsonb),
  'migration_history', coalesce((
    select jsonb_agg(jsonb_build_object('version', version, 'name', name) order by version)
    from supabase_migrations.schema_migrations
    where version in ('20260908000100', '20260912000100', '20260912000200', '20260912000300') or name like '%heroes_agent%'
  ), '[]'::jsonb)
) as metadata;
`;

const VERIFY_QUERY = String.raw`
/* s4b_verification */
select jsonb_build_object(
  'binding', (
    select count(*) = 1 and bool_and(
      heroes_tenant_key = 'acme'
      and supabase_project_ref = 'enjephpxfrbccskdljun'
      and profile_version = '1.0'
      and contract_version = 'rate-contract-1.0'
      and migration_version = '20260912000300'
    )
    from heroes_agent_control.rate_model_state
  ) and (
    select array_agg(a.attname::text order by a.attnum) = array[
      'heroes_tenant_key', 'supabase_project_ref', 'profile_version',
      'contract_version', 'migration_version', 'installed_at'
    ]::text[]
    from pg_catalog.pg_attribute a
    where a.attrelid = 'heroes_agent_control.rate_model_state'::regclass
      and a.attnum > 0 and not a.attisdropped
  ) and (
    select array_agg(conname::text order by conname) = array[
      'rate_model_state_contract_check', 'rate_model_state_migration_check',
      'rate_model_state_pkey', 'rate_model_state_profile_check',
      'rate_model_state_project_check', 'rate_model_state_tenant_check'
    ]::text[]
    from pg_catalog.pg_constraint
    where conrelid = 'heroes_agent_control.rate_model_state'::regclass
  ) and exists (
    select 1 from pg_catalog.pg_class
    where oid = 'heroes_agent_control.rate_model_state'::regclass
      and not relrowsecurity and not relforcerowsecurity
  ) and not exists (
    select 1
    from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(
      coalesce(c.relacl, pg_catalog.acldefault('r'::"char", c.relowner))
    ) a
    where c.oid = 'heroes_agent_control.rate_model_state'::regclass
      and a.grantee <> c.relowner
  ),
  'schema', exists (
    select 1 from pg_catalog.pg_namespace where nspname = 'heroes_agent_rates'
  ) and exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'heroes_agent_acme'
      and not rolsuper and not rolcreatedb and not rolcreaterole and not rolcanlogin
      and not rolreplication and not rolbypassrls
  ) and (
    select count(*) = 1 and bool_and(
      member_role.rolname = 'postgres'
      and membership.admin_option
      and not membership.inherit_option
      and not membership.set_option
    )
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles agent_role
      on agent_role.rolname = 'heroes_agent_acme'
      and membership.roleid = agent_role.oid
    join pg_catalog.pg_roles member_role on member_role.oid = membership.member
  ) and not exists (
    select 1
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles agent_role
      on agent_role.rolname = 'heroes_agent_acme'
      and membership.member = agent_role.oid
  ),
  'table', (
    select array_agg(a.attname::text order by a.attnum) = array[
      'record_id', 'tenant_key', 'card_id', 'journey_type', 'rule_id', 'service_key',
      'locodes', 'timeframes', 'asset_types', 'participants', 'strategy',
      'charge_key', 'amount', 'currency', 'basis', 'minimum', 'maximum', 'tiers',
      'conditions', 'source_file', 'source_ref', 'source_hash', 'approval_status',
      'approved_by', 'approved_at', 'content_hash', 'catalog_response_hash',
      'catalog_fetched_at', 'valid_from', 'valid_to', 'superseded_at', 'created_at', 'updated_at'
    ]::text[]
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'heroes_agent_rates' and c.relname = 'rate_records'
      and a.attnum > 0 and not a.attisdropped
  ) and (
    select bool_and(case
      when a.attname = 'record_id' then pg_catalog.format_type(a.atttypid, a.atttypmod) = 'bigint' and a.attnotnull and a.attidentity = 'a'
      when a.attname in ('amount', 'minimum', 'maximum') then pg_catalog.format_type(a.atttypid, a.atttypmod) = 'numeric(20,6)' and not a.attnotnull
      when a.attname in ('locodes', 'timeframes', 'asset_types', 'participants', 'tiers', 'conditions') then pg_catalog.format_type(a.atttypid, a.atttypmod) = 'jsonb' and a.attnotnull
      when a.attname = 'strategy' then pg_catalog.format_type(a.atttypid, a.atttypmod) = 'jsonb' and not a.attnotnull
      when a.attname in ('catalog_fetched_at', 'valid_from', 'valid_to', 'created_at', 'updated_at') then pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone' and a.attnotnull
      when a.attname in ('approved_at', 'superseded_at') then pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone' and not a.attnotnull
      when a.attname in ('approved_by', 'content_hash') then pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text' and not a.attnotnull
      else pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text' and a.attnotnull
    end)
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'heroes_agent_rates' and c.relname = 'rate_records'
      and a.attnum > 0 and not a.attisdropped
  ),
  'constraints', (
    select array_agg(conname::text order by conname) = array[
      'rate_record_identity', 'rate_records_approval_check', 'rate_records_asset_types_check',
      'rate_records_basis_check', 'rate_records_bounds_check', 'rate_records_card_check',
      'rate_records_catalog_hash_check', 'rate_records_charge_check', 'rate_records_conditions_check',
      'rate_records_content_hash_check', 'rate_records_currency_check', 'rate_records_journey_check',
      'rate_records_locodes_check', 'rate_records_participants_check', 'rate_records_pkey',
      'rate_records_price_check', 'rate_records_rule_check', 'rate_records_service_check',
      'rate_records_source_file_check', 'rate_records_source_hash_check', 'rate_records_source_ref_check',
      'rate_records_strategy_check', 'rate_records_superseded_check', 'rate_records_tenant_check',
      'rate_records_tiers_check', 'rate_records_timeframes_check', 'rate_records_validity_check'
    ]::text[]
      and count(*) filter (where conname = 'rate_records_pkey' and contype = 'p') = 1
      and count(*) filter (
        where conname = 'rate_record_identity' and contype = 'u'
          and pg_catalog.pg_get_constraintdef(oid, true) =
            'UNIQUE (tenant_key, card_id, rule_id, source_hash, charge_key)'
      ) = 1
      and count(*) filter (where conname = 'rate_records_tenant_check' and contype = 'c') = 1
      and count(*) filter (where conname = 'rate_records_approval_check' and contype = 'c') = 1
      and count(*) filter (where conname = 'rate_records_validity_check' and contype = 'c') = 1
      and count(*) filter (where conname = 'rate_records_source_hash_check' and contype = 'c') = 1
      and count(*) filter (where conname = 'rate_records_catalog_hash_check' and contype = 'c') = 1
    from pg_catalog.pg_constraint
    where conrelid = 'heroes_agent_rates.rate_records'::regclass
  ),
  'grants',
    has_schema_privilege('heroes_agent_acme', 'heroes_agent_rates', 'USAGE')
    and not has_schema_privilege('heroes_agent_acme', 'heroes_agent_rates', 'CREATE')
    and has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records', 'SELECT')
    and has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records', 'INSERT')
    and has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records', 'UPDATE')
    and has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records', 'DELETE')
    and not has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records', 'TRUNCATE')
    and not has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records', 'REFERENCES')
    and not has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records', 'TRIGGER')
    and has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_record_list', 'SELECT')
    and has_table_privilege('heroes_agent_acme', 'heroes_agent_rates.discoverable_rate_records', 'SELECT')
    and has_sequence_privilege('heroes_agent_acme', 'heroes_agent_rates.rate_records_record_id_seq', 'USAGE')
    and has_function_privilege('heroes_agent_acme', 'heroes_agent_rates.ingest_rate_record(jsonb)', 'EXECUTE')
    and not has_function_privilege('heroes_agent_acme', 'heroes_agent_rates.set_updated_at()', 'EXECUTE')
    and not has_schema_privilege('anon', 'heroes_agent_rates', 'USAGE')
    and not has_schema_privilege('authenticated', 'heroes_agent_rates', 'USAGE')
    and not has_table_privilege('anon', 'heroes_agent_rates.rate_records', 'SELECT')
    and not has_table_privilege('anon', 'heroes_agent_rates.rate_records', 'INSERT')
    and not has_table_privilege('anon', 'heroes_agent_rates.rate_records', 'UPDATE')
    and not has_table_privilege('anon', 'heroes_agent_rates.rate_records', 'DELETE')
    and not has_table_privilege('authenticated', 'heroes_agent_rates.rate_records', 'SELECT')
    and not has_table_privilege('authenticated', 'heroes_agent_rates.rate_records', 'INSERT')
    and not has_table_privilege('authenticated', 'heroes_agent_rates.rate_records', 'UPDATE')
    and not has_table_privilege('authenticated', 'heroes_agent_rates.rate_records', 'DELETE')
    and not has_function_privilege('anon', 'heroes_agent_rates.ingest_rate_record(jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'heroes_agent_rates.ingest_rate_record(jsonb)', 'EXECUTE')
    and not exists (
      select 1
      from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(
        coalesce(n.nspacl, pg_catalog.acldefault('n'::"char", n.nspowner))
      ) a
      where n.nspname = 'heroes_agent_rates' and a.grantee = 0
    )
    and not exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault(
          case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end,
          c.relowner
        ))
      ) a
      where n.nspname = 'heroes_agent_rates' and a.grantee = 0
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
      ) a
      where n.nspname = 'heroes_agent_rates' and a.grantee = 0
    )
    and not exists (
      select 1
      from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(
        coalesce(n.nspacl, pg_catalog.acldefault('n'::"char", n.nspowner))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee in (
          (select oid from pg_catalog.pg_roles where rolname = 'anon'),
          (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
        )
    )
    and not exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault(
          case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end,
          c.relowner
        ))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee in (
          (select oid from pg_catalog.pg_roles where rolname = 'anon'),
          (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
        )
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee in (
          (select oid from pg_catalog.pg_roles where rolname = 'anon'),
          (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
        )
    )
    and not exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault(
          case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end,
          c.relowner
        ))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'heroes_agent_acme')
        and not (
          (c.relname = 'rate_records' and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
          or (c.relname in ('rate_record_list', 'discoverable_rate_records') and a.privilege_type = 'SELECT')
          or (c.relname = 'rate_records_record_id_seq' and a.privilege_type = 'USAGE')
        )
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'heroes_agent_acme')
        and not (p.proname = 'ingest_rate_record' and a.privilege_type = 'EXECUTE')
    )
    and not exists (
      select 1
      from pg_catalog.pg_namespace n
      cross join lateral pg_catalog.aclexplode(
        coalesce(n.nspacl, pg_catalog.acldefault('n'::"char", n.nspowner))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee not in (
          n.nspowner,
          (select oid from pg_catalog.pg_roles where rolname = 'heroes_agent_acme')
        )
    )
    and not exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault(
          case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end,
          c.relowner
        ))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee not in (
          c.relowner,
          (select oid from pg_catalog.pg_roles where rolname = 'heroes_agent_acme')
        )
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
      ) a
      where n.nspname = 'heroes_agent_rates'
        and a.grantee not in (
          p.proowner,
          (select oid from pg_catalog.pg_roles where rolname = 'heroes_agent_acme')
        )
    ),
  'rls', exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'heroes_agent_rates' and c.relname = 'rate_records'
      and c.relrowsecurity and c.relforcerowsecurity
  ),
  'policies', (
    select count(*) = 4
      and count(*) filter (where polname = 'rate_records_select_acme' and polcmd = 'r' and polqual is not null and polwithcheck is null) = 1
      and count(*) filter (where polname = 'rate_records_insert_acme' and polcmd = 'a' and polqual is null and polwithcheck is not null) = 1
      and count(*) filter (where polname = 'rate_records_update_acme' and polcmd = 'w' and polqual is not null and polwithcheck is not null) = 1
      and count(*) filter (where polname = 'rate_records_delete_acme' and polcmd = 'd' and polqual is not null and polwithcheck is null) = 1
      and bool_and(polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'heroes_agent_acme')])
      and bool_and(
        polqual is null or pg_catalog.pg_get_expr(polqual, polrelid) =
          $policy$((tenant_key = 'acme'::text) AND (tenant_key = current_setting('heroes.tenant_key'::text, true)) AND (CURRENT_USER = 'heroes_agent_acme'::name))$policy$
      )
      and bool_and(
        polwithcheck is null or pg_catalog.pg_get_expr(polwithcheck, polrelid) =
          $policy$((tenant_key = 'acme'::text) AND (tenant_key = current_setting('heroes.tenant_key'::text, true)) AND (CURRENT_USER = 'heroes_agent_acme'::name))$policy$
      )
    from pg_catalog.pg_policy
    where polrelid = 'heroes_agent_rates.rate_records'::regclass
  ),
  'invokerSecurity', (
    select count(*) = 2 and bool_and(c.reloptions @> array['security_invoker=true'])
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'heroes_agent_rates'
      and c.relname in ('rate_record_list', 'discoverable_rate_records') and c.relkind = 'v'
  ) and (
    select lower(pg_catalog.pg_get_viewdef(c.oid, true)) like '%current_setting(''heroes.catalog_response_hash''%'
      and lower(pg_catalog.pg_get_viewdef(c.oid, true)) like '%current_setting(''heroes.query_valid_from''%'
      and lower(pg_catalog.pg_get_viewdef(c.oid, true)) like '%current_setting(''heroes.query_valid_to''%'
      and pg_catalog.strpos(
        lower(pg_catalog.pg_get_viewdef(c.oid, true)),
        'current_setting(''heroes_catalog_response_hash'''
      ) = 0
      and pg_catalog.strpos(
        lower(pg_catalog.pg_get_viewdef(c.oid, true)),
        'current_setting(''heroes_query_valid_from'''
      ) = 0
      and pg_catalog.strpos(
        lower(pg_catalog.pg_get_viewdef(c.oid, true)),
        'current_setting(''heroes_query_valid_to'''
      ) = 0
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'heroes_agent_rates'
      and c.relname = 'discoverable_rate_records' and c.relkind = 'v'
  ) and (
    select count(*) = 2 and bool_and(not p.prosecdef)
      and bool_and(
        p.proconfig = array['search_path=']::text[]
        or p.proconfig = array['search_path=""']::text[]
      )
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'heroes_agent_rates'
      and p.proname in ('ingest_rate_record', 'set_updated_at')
  ),
  'dependencies', (
    select count(distinct view_class.relname) = 2
      and bool_and(dependency_class.oid = 'heroes_agent_rates.rate_records'::regclass)
    from pg_catalog.pg_class view_class
    join pg_catalog.pg_namespace view_schema on view_schema.oid = view_class.relnamespace
    join pg_catalog.pg_rewrite rewrite on rewrite.ev_class = view_class.oid
    join pg_catalog.pg_depend dependency on dependency.objid = rewrite.oid
    join pg_catalog.pg_class dependency_class on dependency_class.oid = dependency.refobjid
    where view_schema.nspname = 'heroes_agent_rates'
      and view_class.relname in ('rate_record_list', 'discoverable_rate_records')
      and dependency_class.relkind in ('r', 'p', 'v', 'm')
      and dependency_class.oid <> view_class.oid
  ) and (
    select definition like '%insert into heroes_agent_rates.rate_records%'
      and definition like '%from heroes_agent_rates.rate_records%'
      and pg_catalog.length(definition) - pg_catalog.length(
        pg_catalog.replace(definition, 'insert into', '')
      ) = pg_catalog.length('insert into')
      and pg_catalog.length(definition) - pg_catalog.length(
        pg_catalog.replace(definition, 'from ', '')
      ) = pg_catalog.length('from ')
      and pg_catalog.strpos(definition, ' join ') = 0
      and pg_catalog.strpos(definition, 'delete from') = 0
      and pg_catalog.strpos(definition, 'update ') = 0
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral (select lower(pg_catalog.pg_get_functiondef(p.oid)) as definition) source
    where n.nspname = 'heroes_agent_rates' and p.proname = 'ingest_rate_record'
  )
) as verification;
`;

const PROBE_QUERY = String.raw`
/* s4b_policy_proof */
begin;

create temporary table s4b_probe_results (
  name text primary key,
  value bigint not null
) on commit drop;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'heroes_agent_other_probe') then
    raise exception 'heroes_agent_other_probe already exists';
  end if;
  create role heroes_agent_other_probe nologin nosuperuser nocreatedb nocreaterole noinherit;
  execute pg_catalog.format(
    'grant heroes_agent_acme to %I with set true',
    current_user
  );
  execute pg_catalog.format(
    'grant heroes_agent_other_probe to %I',
    current_user
  );
end
$$;

grant insert, select on table pg_temp.s4b_probe_results to heroes_agent_acme, heroes_agent_other_probe;
grant usage on schema heroes_agent_rates to heroes_agent_other_probe;
grant select, insert, update, delete on table heroes_agent_rates.rate_records to heroes_agent_other_probe;
grant usage on sequence heroes_agent_rates.rate_records_record_id_seq to heroes_agent_other_probe;
grant execute on function heroes_agent_rates.ingest_rate_record(jsonb) to heroes_agent_other_probe;

set local role heroes_agent_acme;
select set_config('heroes.tenant_key', 'acme', true);
select set_config('heroes.catalog_response_hash', repeat('c', 64), true);
select set_config('heroes.query_valid_from', '2026-09-12T00:00:00Z', true);
select set_config('heroes.query_valid_to', '2026-09-12T23:59:59Z', true);

select heroes_agent_rates.ingest_rate_record(jsonb_build_object(
  'tenantKey', 'acme', 'cardId', 's4b-policy-card', 'journeyType', 'OFFER',
  'ruleId', 's4b-policy-rule', 'serviceKey', 'fcl_freight_forwarding',
  'locodes', '[]'::jsonb, 'timeframes', '[]'::jsonb, 'assetTypes', '[]'::jsonb,
  'participants', '[]'::jsonb, 'chargeKey', 'ocean_freight',
  'amount', '100.000000', 'currency', 'EUR', 'basis', 'container',
  'tiers', '[]'::jsonb, 'conditions', '[]'::jsonb,
  'sourceFile', 's4b-policy-proof', 'sourceRef', 's4b-policy-proof',
  'sourceHash', repeat('a', 64), 'approvalStatus', 'approved',
  'approvedBy', 's4b-policy-proof', 'approvedAt', '2026-09-12T00:00:00Z',
  'contentHash', repeat('b', 64), 'catalogResponseHash', repeat('c', 64),
  'catalogFetchedAt', '2026-09-12T00:00:00Z',
  'validFrom', '2026-09-01T00:00:00Z', 'validTo', '2026-09-30T23:59:59Z'
));

insert into pg_temp.s4b_probe_results
select 'same_tenant_read', count(*)
from heroes_agent_rates.discoverable_rate_records
where card_id = 's4b-policy-card';

with changed as (
  update heroes_agent_rates.rate_records
  set source_ref = 's4b-policy-proof-updated'
  where card_id = 's4b-policy-card'
  returning 1
)
insert into pg_temp.s4b_probe_results select 'same_tenant_write', count(*) from changed;

reset role;
set local role heroes_agent_other_probe;
select set_config('heroes.tenant_key', 'other', true);

insert into pg_temp.s4b_probe_results
select 'cross_tenant_read', count(*)
from heroes_agent_rates.rate_records
where card_id = 's4b-policy-card';

with changed as (
  update heroes_agent_rates.rate_records set source_ref = 'blocked'
  where card_id = 's4b-policy-card' returning 1
)
insert into pg_temp.s4b_probe_results select 'cross_tenant_update', count(*) from changed;

with changed as (
  delete from heroes_agent_rates.rate_records
  where card_id = 's4b-policy-card' returning 1
)
insert into pg_temp.s4b_probe_results select 'cross_tenant_delete', count(*) from changed;

do $$
begin
  begin
    perform heroes_agent_rates.ingest_rate_record(jsonb_build_object(
      'tenantKey', 'acme', 'cardId', 's4b-cross-insert', 'journeyType', 'OFFER',
      'ruleId', 's4b-cross-rule', 'serviceKey', 'fcl_freight_forwarding',
      'locodes', '[]'::jsonb, 'timeframes', '[]'::jsonb, 'assetTypes', '[]'::jsonb,
      'participants', '[]'::jsonb, 'chargeKey', 'ocean_freight', 'amount', '1',
      'currency', 'EUR', 'basis', 'container', 'sourceFile', 'proof', 'sourceRef', 'proof',
      'sourceHash', repeat('d', 64), 'approvalStatus', 'draft',
      'catalogResponseHash', repeat('c', 64), 'catalogFetchedAt', '2026-09-12T00:00:00Z',
      'validFrom', '2026-09-01T00:00:00Z', 'validTo', '2026-09-30T23:59:59Z'
    ));
    raise exception 'cross-tenant insert unexpectedly succeeded';
  exception when insufficient_privilege then
    insert into pg_temp.s4b_probe_results values ('cross_tenant_insert_rejected', 1);
  end;
end
$$;

select set_config('heroes.tenant_key', 'acme', true);

do $$
declare
  visible_rows bigint;
begin
  select count(*) into visible_rows
  from heroes_agent_rates.rate_records where card_id = 's4b-policy-card';
  if visible_rows <> 0 then raise exception 'forged ACME context disclosed a row'; end if;

  begin
    perform heroes_agent_rates.ingest_rate_record(jsonb_build_object(
      'tenantKey', 'acme', 'cardId', 's4b-forged-insert', 'journeyType', 'OFFER',
      'ruleId', 's4b-forged-rule', 'serviceKey', 'fcl_freight_forwarding',
      'locodes', '[]'::jsonb, 'timeframes', '[]'::jsonb, 'assetTypes', '[]'::jsonb,
      'participants', '[]'::jsonb, 'chargeKey', 'ocean_freight', 'amount', '1',
      'currency', 'EUR', 'basis', 'container', 'sourceFile', 'proof', 'sourceRef', 'proof',
      'sourceHash', repeat('e', 64), 'approvalStatus', 'draft',
      'catalogResponseHash', repeat('c', 64), 'catalogFetchedAt', '2026-09-12T00:00:00Z',
      'validFrom', '2026-09-01T00:00:00Z', 'validTo', '2026-09-30T23:59:59Z'
    ));
    raise exception 'forged ACME context inserted a row';
  exception when insufficient_privilege then
    insert into pg_temp.s4b_probe_results values ('forged_acme_context_blocked', 1);
  end;
end
$$;

reset role;

do $$
begin
  if (select value from pg_temp.s4b_probe_results where name = 'same_tenant_read') <> 1
    or (select value from pg_temp.s4b_probe_results where name = 'same_tenant_write') <> 1
    or (select value from pg_temp.s4b_probe_results where name = 'cross_tenant_read') <> 0
    or (select value from pg_temp.s4b_probe_results where name = 'cross_tenant_update') <> 0
    or (select value from pg_temp.s4b_probe_results where name = 'cross_tenant_delete') <> 0
    or (select value from pg_temp.s4b_probe_results where name = 'cross_tenant_insert_rejected') <> 1
    or (select value from pg_temp.s4b_probe_results where name = 'forged_acme_context_blocked') <> 1
  then
    raise exception 'S4b tenant policy proof failed';
  end if;
end
$$;

rollback;

select jsonb_build_object(
  'sameTenantRead', true,
  'sameTenantWrite', true,
  'crossTenantReadCount', 0,
  'crossTenantUpdateCount', 0,
  'crossTenantDeleteCount', 0,
  'crossTenantInsertRejected', true,
  'forgedAcmeContextBlocked', true
) as proof;
`;

const CLEANUP_QUERY = String.raw`
/* s4b_cleanup_verification */
select jsonb_build_object(
  'rolledBack',
    not exists (
      select 1 from pg_catalog.pg_roles where rolname = 'heroes_agent_other_probe'
    )
    and (
      select count(*) = 1 and bool_and(
        member_role.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
      from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles agent_role
        on agent_role.rolname = 'heroes_agent_acme'
        and membership.roleid = agent_role.oid
      join pg_catalog.pg_roles member_role on member_role.oid = membership.member
    )
    and not exists (
      select 1
      from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles agent_role
        on agent_role.rolname = 'heroes_agent_acme'
        and membership.member = agent_role.oid
    )
    and not exists (
      select 1 from heroes_agent_rates.rate_records
      where card_id in ('s4b-policy-card', 's4b-cross-insert', 's4b-forged-insert')
    )
) as cleanup;
`;

function readBinding(): Binding {
  const path = join(process.cwd(), 'self', 'supabase', 'binding.json');
  if (!existsSync(path)) throw failure('project_identity_mismatch', 'Supabase binding is missing.');
  let binding: Binding;
  try {
    binding = JSON.parse(readFileSync(path, 'utf8')) as Binding;
  } catch {
    throw failure('project_identity_mismatch', 'Supabase binding is invalid.');
  }
  if (
    binding.schemaVersion !== '1.0' ||
    binding.heroesTenantKey !== TENANT_KEY ||
    binding.supabaseProjectRef !== PROJECT_REF ||
    binding.supabaseProjectName !== PROJECT_NAME ||
    binding.supabaseRegion !== PROJECT_REGION
  ) {
    throw failure('project_identity_mismatch', 'Supabase binding does not match the confirmed ACME project.');
  }
  return binding;
}

async function verifyInstalled(): Promise<Record<string, unknown>> {
  const value = await managementRequest({ action: 'query-read-only', projectRef: PROJECT_REF, query: VERIFY_QUERY });
  const verification = objectResult(value, 'verification');
  const fields = ['binding', 'schema', 'table', 'constraints', 'grants', 'rls', 'policies', 'invokerSecurity', 'dependencies'];
  const failedFields = fields.filter((field) => verification[field] !== true);
  if (failedFields.length) {
    throw failure('verification_failed', `Installed rate model differs in: ${failedFields.join(', ')}.`);
  }
  return verification;
}

async function provePolicies(): Promise<Record<string, unknown>> {
  const value = await managementRequest({ action: 'query-write', projectRef: PROJECT_REF, query: PROBE_QUERY });
  const proof = objectResult(value, 'proof');
  const cleanupValue = await managementRequest({
    action: 'query-read-only', projectRef: PROJECT_REF, query: CLEANUP_QUERY,
  });
  const cleanup = objectResult(cleanupValue, 'cleanup');
  proof.rolledBack = cleanup.rolledBack;
  if (
    proof.sameTenantRead !== true || proof.sameTenantWrite !== true ||
    proof.crossTenantReadCount !== 0 || proof.crossTenantUpdateCount !== 0 ||
    proof.crossTenantDeleteCount !== 0 || proof.crossTenantInsertRejected !== true ||
    proof.forgedAcmeContextBlocked !== true || proof.rolledBack !== true
  ) {
    throw failure('verification_failed', 'Database tenant-isolation proof failed.');
  }
  return proof;
}

function buildProfile(status: RateProfile['status']): RateProfile {
  return parseRateProfile({
    profileVersion: '1.0',
    status,
    binding: { heroesTenantKey: TENANT_KEY, supabaseProjectRef: PROJECT_REF },
    resources: [
      { id: 'store', kind: 'table', name: 'heroes_agent_rates.rate_records' },
      { id: 'discover', kind: 'view', name: 'heroes_agent_rates.discoverable_rate_records' },
      { id: 'list', kind: 'view', name: 'heroes_agent_rates.rate_record_list' },
      { id: 'write', kind: 'function', name: 'heroes_agent_rates.ingest_rate_record' },
    ],
    operations: {
      ingest: { resource: 'write', contract: 'rate-contract-1.0', securityMode: 'invoker', tenantEnforcement: { method: 'database-rls', tenantField: 'tenant.key', contextKey: 'heroes.tenant_key', protectedResources: ['store'] } },
      discover: { resource: 'discover', contract: 'rate-contract-1.0', securityMode: 'invoker', tenantEnforcement: { method: 'database-rls', tenantField: 'tenant.key', contextKey: 'heroes.tenant_key', protectedResources: ['store'] } },
      list: { resource: 'list', contract: 'rate-contract-1.0', securityMode: 'invoker', tenantEnforcement: { method: 'database-rls', tenantField: 'tenant.key', contextKey: 'heroes.tenant_key', protectedResources: ['store'] } },
    },
    fields: [
      ['tenant.key', 'tenant_key'], ['card.id', 'card_id'], ['card.journeyType', 'journey_type'],
      ['rule.id', 'rule_id'], ['rule.serviceKey', 'service_key'], ['rule.locodes', 'locodes'],
      ['rule.timeframes', 'timeframes'], ['rule.assetTypes', 'asset_types'],
      ['rule.participants', 'participants'], ['rule.strategy', 'strategy'],
      ['charge.chargeKey', 'charge_key'], ['charge.amount', 'amount'],
      ['charge.currency', 'currency'], ['charge.basis', 'basis'],
      ['charge.minimum', 'minimum'], ['charge.maximum', 'maximum'], ['charge.tiers', 'tiers'],
      ['rule.conditions', 'conditions'], ['source.sourceFile', 'source_file'],
      ['source.sourceRef', 'source_ref'], ['source.sourceHash', 'source_hash'],
      ['approval.status', 'approval_status'], ['approval.approvedBy', 'approved_by'],
      ['approval.approvedAt', 'approved_at'], ['approval.contentHash', 'content_hash'],
      ['catalog.responseHash', 'catalog_response_hash'], ['catalog.fetchedAt', 'catalog_fetched_at'],
    ].map(([semantic, path]) => ({ semantic, resource: 'store', path })),
    controls: {
      tenantIsolation: { method: 'rls', tenantField: 'tenant.key', protectedResources: ['store'] },
      grants: { public: 'none', anon: 'none', authenticated: 'none', operationalRole: 'heroes_agent_acme', coveredResources: ['store', 'discover', 'list', 'write'] },
      approval: { statusField: 'approval.status', approvedByField: 'approval.approvedBy', approvedAtField: 'approval.approvedAt', contentHashField: 'approval.contentHash', rule: 'valid-content-hash' },
      current: { catalogHashField: 'catalog.responseHash', rule: 'equals-active-heroes-catalog' },
      validity: { timeframesField: 'rule.timeframes', rule: 'contains-query-window' },
      provenance: { fields: ['source.sourceFile', 'source.sourceRef', 'source.sourceHash', 'catalog.responseHash', 'catalog.fetchedAt'] },
      idempotency: { fields: ['tenant.key', 'card.id', 'rule.id', 'source.sourceHash'], resource: 'store', constraint: 'rate_record_identity' },
    },
  }, { heroesTenantKey: TENANT_KEY, supabaseProjectRef: PROJECT_REF });
}

function profileHash(profile: RateProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

run(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const action = positional[0];
  if (!action || positional.length !== 1) {
    throw failure('usage', 'Use discover, propose, confirm, install, or reload.');
  }
  if (flagString(flags, 'project-ref') && flagString(flags, 'project-ref') !== PROJECT_REF) {
    throw failure('project_identity_mismatch', 'Project ref does not match the confirmed ACME project.');
  }
  const binding = readBinding();

  if (action === 'discover') {
    const project = await managementRequest({ action: 'project', projectRef: PROJECT_REF }) as Record<string, unknown>;
    if (project.ref !== PROJECT_REF || project.name !== PROJECT_NAME || project.region !== PROJECT_REGION) {
      throw failure('project_identity_mismatch', 'Live Supabase project does not match the confirmed binding.');
    }
    const rows = await managementRequest({ action: 'query-read-only', projectRef: PROJECT_REF, query: METADATA_QUERY }) as { metadata?: { schemas?: { name?: string }[] } }[];
    const schemas = rows[0]?.metadata?.schemas?.map(({ name }) => name).filter((name): name is string => !!name) ?? [];
    const verification = schemas.includes('heroes_agent_rates') ? await verifyInstalled() : undefined;
    process.stdout.write(`${JSON.stringify({
      binding: {
        heroesTenantKey: binding.heroesTenantKey,
        supabaseProjectRef: binding.supabaseProjectRef,
        supabaseProjectName: binding.supabaseProjectName,
        supabaseRegion: binding.supabaseRegion,
      },
      schemas,
      rateSchemaExists: schemas.includes('heroes_agent_rates'),
      metadata: rows[0]?.metadata ?? {},
      ...(verification ? { verification } : {}),
    })}\n`);
    return;
  }

  if (action === 'propose') {
    const profile = buildProfile('proposal');
    process.stdout.write(`${JSON.stringify({ proposalHash: profileHash(profile), profile })}\n`);
    return;
  }

  if (action === 'confirm') {
    const proposal = buildProfile('proposal');
    const expectedHash = profileHash(proposal);
    if (flagString(flags, 'proposal-hash') !== expectedHash) {
      throw failure('proposal_mismatch', 'Proposal hash does not match the current confirmed schema proposal.');
    }
    process.stdout.write(`${JSON.stringify({
      status: 'confirmed-for-installation',
      proposalHash: expectedHash,
      heroesTenantKey: binding.heroesTenantKey,
      supabaseProjectRef: binding.supabaseProjectRef,
    })}\n`);
    return;
  }

  if (action === 'install') {
    const proposal = buildProfile('proposal');
    const expectedHash = profileHash(proposal);
    if (flagString(flags, 'proposal-hash') !== expectedHash) {
      throw failure('proposal_mismatch', 'Proposal hash does not match the confirmed schema proposal.');
    }
    requireCli(toolsDir);
    const projectDir = prepareMigrations({
      workspace: process.cwd(), bootstrapProject, migrations: rateMigrations,
    });
    const attemptPath = join(process.cwd(), 'self', 'supabase', 'migration-attempt.json');
    if (existsSync(attemptPath)) {
      throw failure('migration_partial', 'A prior migration attempt requires operator inspection.');
    }
    const requiredMigrations = [
      { version: RATE_MODEL_MIGRATION_VERSION },
      {
        version: TENANT_CONTEXT_MIGRATION_VERSION,
        missingDependencyMessage: 'The S4b tenant-context migration lacks its rate-model migration.',
      },
      {
        version: QUERY_CONTEXT_MIGRATION_VERSION,
        missingDependencyMessage: 'The S4b query-context migration lacks its tenant-context migration.',
      },
    ];
    const historyOptions = {
      requiredMigrations,
      missingRequiredMessage: 'The S4b query-context migration did not verify.',
    };
    const before = migrationRows(toolsDir, projectDir, PROJECT_REF);
    const alreadyApplied = assertMigrationHistory({ rows: before, requireAll: false, ...historyOptions });
    dryRunPush(toolsDir, projectDir, PROJECT_REF);
    if (!alreadyApplied) {
      writeAttempt(attemptPath, {
        schemaVersion: '1.0', heroesTenantKey: TENANT_KEY, supabaseProjectRef: PROJECT_REF,
        migrationVersion: QUERY_CONTEXT_MIGRATION_VERSION, proposalHash: expectedHash, status: 'applying',
      });
      applyPush(toolsDir, projectDir, PROJECT_REF);
      assertMigrationHistory({
        rows: migrationRows(toolsDir, projectDir, PROJECT_REF), requireAll: true, ...historyOptions,
      });
    }
    if (!existsSync(attemptPath)) {
      writeAttempt(attemptPath, {
        schemaVersion: '1.0', heroesTenantKey: TENANT_KEY, supabaseProjectRef: PROJECT_REF,
        migrationVersion: QUERY_CONTEXT_MIGRATION_VERSION, proposalHash: expectedHash, status: 'applying',
      });
    }
    const verification = await verifyInstalled();
    const proof = await provePolicies();
    persistConfirmedRateProfile(process.cwd(), buildProfile('confirmed'));
    if (existsSync(attemptPath)) unlinkSync(attemptPath);
    process.stdout.write(`${JSON.stringify({
      status: 'installed-and-verified', proposalHash: expectedHash,
      migrationVersion: QUERY_CONTEXT_MIGRATION_VERSION, migrationApplied: !alreadyApplied,
      verification, proof,
    })}\n`);
    return;
  }

  if (action === 'reload') {
    const profile = loadConfirmedRateProfile(process.cwd());
    const proposal = structuredClone(profile);
    proposal.status = 'proposal';
    process.stdout.write(`${JSON.stringify({
      status: profile.status,
      proposalHash: profileHash(proposal),
      heroesTenantKey: profile.binding.heroesTenantKey,
      supabaseProjectRef: profile.binding.supabaseProjectRef,
    })}\n`);
    return;
  }

  throw failure('usage', `Action ${action} is not implemented yet.`);
});
