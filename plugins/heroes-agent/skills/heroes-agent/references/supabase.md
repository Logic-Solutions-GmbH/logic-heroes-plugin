# Supabase project bootstrap

Supabase is private operational memory. Heroes remains authoritative for network identity, shared workflows, events, and exchanged attachments.

S3 connects one peer workspace to one explicit Supabase project. It creates only the private `heroes_agent_control` bootstrap schema. Rate tables, grants, RLS policies, and rate mappings belong to S4.

## Required human values

Ask the human for one Supabase project reference. Never infer it from a project name.

The human must set these values in ignored `self/.env`:

```text
SUPABASE_ACCESS_TOKEN=
SUPABASE_DB_PASSWORD=
```

Never print either value. OAuth remains the marketplace target. These local credentials are only the practical bootstrap path.

## Safe procedure

Run all commands from the peer workspace.

1. Preview the exact target and migration:

   ```text
   node <plugin-root>/scripts/run-tool.mjs bootstrap-supabase.ts --project-ref <20-character-project-ref> --dry-run
   ```

2. Compare the shown Heroes tenant, project name, region, and local binding path with the human's selection.
3. Apply the versioned control-plane migration:

   ```text
   node <plugin-root>/scripts/run-tool.mjs bootstrap-supabase.ts --project-ref <20-character-project-ref>
   ```

4. Run the command again without `--project-ref`:

   ```text
   node <plugin-root>/scripts/run-tool.mjs bootstrap-supabase.ts
   ```

The second run must report `already up to date; no migration applied`.

The command uses pinned Supabase CLI `2.117.0`. It executes `projects list`, then uses the verified project ref for `migration list`, `db push --dry-run`, `db push`, and final `migration list`. It does not depend on local CLI link state. Credentials pass only through the process environment.

The ignored `self/supabase/binding.json` file records the exact Heroes tenant, project reference, project name, and region. The command refuses a different tenant or project selection.

## Failure meanings

| Code | Meaning | Response |
|---|---|---|
| `configuration_missing` | Identity, credential, project reference, or pinned CLI is missing. | Add only the named local value. |
| `project_binding_ambiguous` | Local identity or binding contains conflicting values. | Inspect the local files. Do not select automatically. |
| `project_identity_mismatch` | The selected project is not uniquely accessible, or the binding belongs to another tenant. | Stop before migration. Confirm the non-secret IDs. |
| `authentication_failed` | Supabase rejected the access token or database password. | Replace the local credential. Never paste it into chat. |
| `project_unreachable` | The API or database cannot be reached. | Fix network access, then repeat the preview. |
| `migration_history_mismatch` | Remote history differs from the private bootstrap workdir. | Stop for operator review. |
| `migration_failed` | The migration command failed. | Treat the database as possibly partial. Inspect before retry. |
| `migration_partial` | Verification did not find matching local and remote migration versions. | Stop for operator recovery. |

The command never runs `migration repair`. Repair changes migration history only. An operator must first confirm the real schema state.

Before an apply, the command writes ignored `self/supabase/migration-attempt.json`. It removes this file only after migration-history verification succeeds. If the file remains, later runs stop before another migration attempt. An operator must compare the real schema and history first. Remove the marker only after that review establishes a safe retry or completes explicit recovery.

## Inbox archive ruling

CLI orchestration owns inbox archival. `RateStore.ingestRates` persists rows only. The CLI moves source files after successful persistence. Adapters never archive inputs.
