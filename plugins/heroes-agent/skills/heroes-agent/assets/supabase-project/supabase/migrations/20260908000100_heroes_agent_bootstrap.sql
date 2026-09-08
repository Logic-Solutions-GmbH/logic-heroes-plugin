create schema if not exists heroes_agent_control;

revoke all on schema heroes_agent_control from public, anon, authenticated;

create table if not exists heroes_agent_control.bootstrap_state (
  singleton boolean primary key default true check (singleton),
  schema_version text not null,
  installed_at timestamptz not null default now()
);

revoke all on table heroes_agent_control.bootstrap_state from public, anon, authenticated;

insert into heroes_agent_control.bootstrap_state (singleton, schema_version)
values (true, '1.0')
on conflict (singleton) do update
set schema_version = excluded.schema_version;
