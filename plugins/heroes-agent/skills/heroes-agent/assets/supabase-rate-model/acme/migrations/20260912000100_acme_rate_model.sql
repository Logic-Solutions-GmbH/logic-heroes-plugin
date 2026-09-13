do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'heroes_agent_acme') then
    create role heroes_agent_acme nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end
$$;

create schema if not exists heroes_agent_rates;

revoke all on schema heroes_agent_rates from public, anon, authenticated;

create table if not exists heroes_agent_control.rate_model_state (
  heroes_tenant_key text primary key,
  supabase_project_ref text not null,
  profile_version text not null,
  contract_version text not null,
  migration_version text not null,
  installed_at timestamptz not null default now(),
  constraint rate_model_state_tenant_check check (heroes_tenant_key = 'acme'),
  constraint rate_model_state_project_check check (supabase_project_ref = 'enjephpxfrbccskdljun'),
  constraint rate_model_state_profile_check check (profile_version = '1.0'),
  constraint rate_model_state_contract_check check (contract_version = 'rate-contract-1.0'),
  constraint rate_model_state_migration_check check (migration_version = '20260912000100')
);

revoke all on table heroes_agent_control.rate_model_state from public, anon, authenticated;

insert into heroes_agent_control.rate_model_state (
  heroes_tenant_key, supabase_project_ref, profile_version, contract_version, migration_version
)
values ('acme', 'enjephpxfrbccskdljun', '1.0', 'rate-contract-1.0', '20260912000100')
on conflict (heroes_tenant_key) do update
set supabase_project_ref = excluded.supabase_project_ref,
    profile_version = excluded.profile_version,
    contract_version = excluded.contract_version,
    migration_version = excluded.migration_version;

create table if not exists heroes_agent_rates.rate_records (
  record_id bigint generated always as identity,
  tenant_key text not null,
  card_id text not null,
  journey_type text not null,
  rule_id text not null,
  service_key text not null,
  locodes jsonb not null,
  timeframes jsonb not null,
  asset_types jsonb not null,
  participants jsonb not null,
  strategy jsonb,
  charge_key text not null,
  amount numeric(20, 6),
  currency text not null,
  basis text not null,
  minimum numeric(20, 6),
  maximum numeric(20, 6),
  tiers jsonb not null default '[]'::jsonb,
  conditions jsonb not null default '[]'::jsonb,
  source_file text not null,
  source_ref text not null,
  source_hash text not null,
  approval_status text not null,
  approved_by text,
  approved_at timestamptz,
  content_hash text,
  catalog_response_hash text not null,
  catalog_fetched_at timestamptz not null,
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rate_records_pkey primary key (record_id),
  constraint rate_records_tenant_check check (tenant_key = 'acme'),
  constraint rate_records_journey_check check (journey_type = 'OFFER'),
  constraint rate_records_card_check check (btrim(card_id) <> ''),
  constraint rate_records_rule_check check (btrim(rule_id) <> ''),
  constraint rate_records_service_check check (btrim(service_key) <> ''),
  constraint rate_records_charge_check check (btrim(charge_key) <> ''),
  constraint rate_records_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint rate_records_basis_check check (btrim(basis) <> ''),
  constraint rate_records_source_file_check check (btrim(source_file) <> ''),
  constraint rate_records_source_ref_check check (btrim(source_ref) <> ''),
  constraint rate_records_source_hash_check check (source_hash ~ '^[0-9a-f]{64}$'),
  constraint rate_records_catalog_hash_check check (catalog_response_hash ~ '^[0-9a-f]{64}$'),
  constraint rate_records_content_hash_check check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  constraint rate_records_locodes_check check (jsonb_typeof(locodes) = 'array'),
  constraint rate_records_timeframes_check check (jsonb_typeof(timeframes) = 'array'),
  constraint rate_records_asset_types_check check (jsonb_typeof(asset_types) = 'array'),
  constraint rate_records_participants_check check (jsonb_typeof(participants) = 'array'),
  constraint rate_records_strategy_check check (strategy is null or jsonb_typeof(strategy) = 'object'),
  constraint rate_records_tiers_check check (jsonb_typeof(tiers) = 'array'),
  constraint rate_records_conditions_check check (jsonb_typeof(conditions) = 'array'),
  constraint rate_records_price_check check (amount is not null or jsonb_array_length(tiers) > 0),
  constraint rate_records_bounds_check check (minimum is null or maximum is null or minimum <= maximum),
  constraint rate_records_validity_check check (valid_from <= valid_to),
  constraint rate_records_superseded_check check (superseded_at is null or superseded_at >= created_at),
  constraint rate_records_approval_check check (
    (approval_status = 'draft' and approved_by is null and approved_at is null and content_hash is null)
    or
    (approval_status = 'approved' and btrim(approved_by) <> '' and approved_at is not null and content_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint rate_record_identity unique (tenant_key, card_id, rule_id, source_hash, charge_key)
);

alter table heroes_agent_rates.rate_records enable row level security;
alter table heroes_agent_rates.rate_records force row level security;

drop policy if exists rate_records_select_acme on heroes_agent_rates.rate_records;
create policy rate_records_select_acme on heroes_agent_rates.rate_records
for select to heroes_agent_acme
using (tenant_key = 'acme' and tenant_key = current_setting('heroes_tenant_key', true) and current_user = 'heroes_agent_acme');

drop policy if exists rate_records_insert_acme on heroes_agent_rates.rate_records;
create policy rate_records_insert_acme on heroes_agent_rates.rate_records
for insert to heroes_agent_acme
with check (tenant_key = 'acme' and tenant_key = current_setting('heroes_tenant_key', true) and current_user = 'heroes_agent_acme');

drop policy if exists rate_records_update_acme on heroes_agent_rates.rate_records;
create policy rate_records_update_acme on heroes_agent_rates.rate_records
for update to heroes_agent_acme
using (tenant_key = 'acme' and tenant_key = current_setting('heroes_tenant_key', true) and current_user = 'heroes_agent_acme')
with check (tenant_key = 'acme' and tenant_key = current_setting('heroes_tenant_key', true) and current_user = 'heroes_agent_acme');

drop policy if exists rate_records_delete_acme on heroes_agent_rates.rate_records;
create policy rate_records_delete_acme on heroes_agent_rates.rate_records
for delete to heroes_agent_acme
using (tenant_key = 'acme' and tenant_key = current_setting('heroes_tenant_key', true) and current_user = 'heroes_agent_acme');

create or replace view heroes_agent_rates.rate_record_list
with (security_invoker = true)
as select * from heroes_agent_rates.rate_records;

create or replace view heroes_agent_rates.discoverable_rate_records
with (security_invoker = true)
as
select * from heroes_agent_rates.rate_records
where approval_status = 'approved'
  and approved_by is not null
  and approved_at is not null
  and content_hash ~ '^[0-9a-f]{64}$'
  and superseded_at is null
  and catalog_response_hash = current_setting('heroes_catalog_response_hash', true)
  and valid_from <= coalesce(nullif(current_setting('heroes_query_valid_from', true), '')::timestamptz, '-infinity'::timestamptz)
  and valid_to >= coalesce(nullif(current_setting('heroes_query_valid_to', true), '')::timestamptz, 'infinity'::timestamptz);

create or replace function heroes_agent_rates.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rate_records_set_updated_at on heroes_agent_rates.rate_records;
create trigger rate_records_set_updated_at
before update on heroes_agent_rates.rate_records
for each row execute function heroes_agent_rates.set_updated_at();

create or replace function heroes_agent_rates.ingest_rate_record(p_record jsonb)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted_id bigint;
begin
  insert into heroes_agent_rates.rate_records (
    tenant_key, card_id, journey_type, rule_id, service_key,
    locodes, timeframes, asset_types, participants, strategy,
    charge_key, amount, currency, basis, minimum, maximum, tiers, conditions,
    source_file, source_ref, source_hash,
    approval_status, approved_by, approved_at, content_hash,
    catalog_response_hash, catalog_fetched_at,
    valid_from, valid_to, superseded_at
  )
  values (
    p_record->>'tenantKey', p_record->>'cardId', p_record->>'journeyType',
    p_record->>'ruleId', p_record->>'serviceKey',
    coalesce(p_record->'locodes', '[]'::jsonb), coalesce(p_record->'timeframes', '[]'::jsonb),
    coalesce(p_record->'assetTypes', '[]'::jsonb), coalesce(p_record->'participants', '[]'::jsonb),
    p_record->'strategy', p_record->>'chargeKey', nullif(p_record->>'amount', '')::numeric,
    p_record->>'currency', p_record->>'basis', nullif(p_record->>'minimum', '')::numeric,
    nullif(p_record->>'maximum', '')::numeric, coalesce(p_record->'tiers', '[]'::jsonb),
    coalesce(p_record->'conditions', '[]'::jsonb), p_record->>'sourceFile',
    p_record->>'sourceRef', p_record->>'sourceHash', p_record->>'approvalStatus',
    nullif(p_record->>'approvedBy', ''), nullif(p_record->>'approvedAt', '')::timestamptz,
    nullif(p_record->>'contentHash', ''), p_record->>'catalogResponseHash',
    (p_record->>'catalogFetchedAt')::timestamptz, (p_record->>'validFrom')::timestamptz,
    (p_record->>'validTo')::timestamptz, nullif(p_record->>'supersededAt', '')::timestamptz
  )
  on conflict on constraint rate_record_identity do nothing
  returning record_id into inserted_id;

  if inserted_id is null then
    select record_id into inserted_id
    from heroes_agent_rates.rate_records
    where tenant_key = p_record->>'tenantKey'
      and card_id = p_record->>'cardId'
      and rule_id = p_record->>'ruleId'
      and source_hash = p_record->>'sourceHash'
      and charge_key = p_record->>'chargeKey';
  end if;

  return inserted_id;
end;
$$;

revoke all on table heroes_agent_rates.rate_records from public, anon, authenticated;
revoke all on table heroes_agent_rates.rate_record_list from public, anon, authenticated;
revoke all on table heroes_agent_rates.discoverable_rate_records from public, anon, authenticated;
revoke all on sequence heroes_agent_rates.rate_records_record_id_seq from public, anon, authenticated;
revoke all on function heroes_agent_rates.ingest_rate_record(jsonb) from public, anon, authenticated;
revoke all on function heroes_agent_rates.set_updated_at() from public, anon, authenticated;

grant usage on schema heroes_agent_rates to heroes_agent_acme;
grant select, insert, update, delete on table heroes_agent_rates.rate_records to heroes_agent_acme;
grant select on table heroes_agent_rates.rate_record_list to heroes_agent_acme;
grant select on table heroes_agent_rates.discoverable_rate_records to heroes_agent_acme;
grant usage on sequence heroes_agent_rates.rate_records_record_id_seq to heroes_agent_acme;
grant execute on function heroes_agent_rates.ingest_rate_record(jsonb) to heroes_agent_acme;
