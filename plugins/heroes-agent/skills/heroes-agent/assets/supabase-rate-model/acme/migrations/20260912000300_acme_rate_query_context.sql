alter table heroes_agent_control.rate_model_state
drop constraint rate_model_state_migration_check;

update heroes_agent_control.rate_model_state
set migration_version = '20260912000300'
where heroes_tenant_key = 'acme';

alter table heroes_agent_control.rate_model_state
add constraint rate_model_state_migration_check
check (migration_version = '20260912000300');

create or replace view heroes_agent_rates.discoverable_rate_records
with (security_invoker = true)
as
select * from heroes_agent_rates.rate_records
where approval_status = 'approved'
  and approved_by is not null
  and approved_at is not null
  and content_hash ~ '^[0-9a-f]{64}$'
  and superseded_at is null
  and catalog_response_hash = current_setting('heroes.catalog_response_hash', true)
  and valid_from <= coalesce(nullif(current_setting('heroes.query_valid_from', true), '')::timestamptz, '-infinity'::timestamptz)
  and valid_to >= coalesce(nullif(current_setting('heroes.query_valid_to', true), '')::timestamptz, 'infinity'::timestamptz);
