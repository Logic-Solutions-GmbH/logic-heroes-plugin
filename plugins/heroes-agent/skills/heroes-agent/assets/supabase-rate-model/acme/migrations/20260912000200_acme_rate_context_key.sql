alter table heroes_agent_control.rate_model_state
drop constraint rate_model_state_migration_check;

update heroes_agent_control.rate_model_state
set migration_version = '20260912000200'
where heroes_tenant_key = 'acme';

alter table heroes_agent_control.rate_model_state
add constraint rate_model_state_migration_check
check (migration_version = '20260912000200');

drop policy rate_records_select_acme on heroes_agent_rates.rate_records;
create policy rate_records_select_acme on heroes_agent_rates.rate_records
for select to heroes_agent_acme
using (tenant_key = 'acme' and tenant_key = current_setting('heroes.tenant_key', true) and current_user = 'heroes_agent_acme');

drop policy rate_records_insert_acme on heroes_agent_rates.rate_records;
create policy rate_records_insert_acme on heroes_agent_rates.rate_records
for insert to heroes_agent_acme
with check (tenant_key = 'acme' and tenant_key = current_setting('heroes.tenant_key', true) and current_user = 'heroes_agent_acme');

drop policy rate_records_update_acme on heroes_agent_rates.rate_records;
create policy rate_records_update_acme on heroes_agent_rates.rate_records
for update to heroes_agent_acme
using (tenant_key = 'acme' and tenant_key = current_setting('heroes.tenant_key', true) and current_user = 'heroes_agent_acme')
with check (tenant_key = 'acme' and tenant_key = current_setting('heroes.tenant_key', true) and current_user = 'heroes_agent_acme');

drop policy rate_records_delete_acme on heroes_agent_rates.rate_records;
create policy rate_records_delete_acme on heroes_agent_rates.rate_records
for delete to heroes_agent_acme
using (tenant_key = 'acme' and tenant_key = current_setting('heroes.tenant_key', true) and current_user = 'heroes_agent_acme');
