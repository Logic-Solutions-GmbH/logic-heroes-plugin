# Supabase rate profile

The rate profile records one confirmed mapping between the stable rate contract and one user's Supabase schema. It does not prescribe a universal table layout. It contains no credential and no SQL.

The private profile path is `self/supabase/rate-profile.json`. The loader compares its Heroes tenant and Supabase project reference with `self/supabase/binding.json`. It refuses a mismatch. The peer template ignores the complete `self/supabase/` directory.

## Protocol

Use this sequence before a Supabase rate adapter can read or write rates:

1. Discover the selected project's tables, views, functions, RLS policies, grants, and uniqueness constraints.
2. Propose a profile with `status` set to `proposal`.
3. Show the non-secret tenant, project reference, resource names, field paths, and safety declarations to the human.
4. Ask the human to confirm the complete proposal. Do not infer confirmation from project access.
5. Change `status` to `confirmed`. Parse and persist it with `persistConfirmedRateProfile`.
6. In each later process, use `loadConfirmedRateProfile`. Resolve fields and operations through `resolveRateField` and `resolveRateOperation`.

An adapter must not use a proposal. Discovery must not change the database.

## ACME S4b installation

The versioned ACME model is bound to tenant `acme` and project `enjephpxfrbccskdljun`. Use the exact state sequence:

```text
node <plugin-root>/scripts/run-tool.mjs supabase-rate-model.ts discover
node <plugin-root>/scripts/run-tool.mjs supabase-rate-model.ts propose
node <plugin-root>/scripts/run-tool.mjs supabase-rate-model.ts confirm --proposal-hash <confirmed-hash>
node <plugin-root>/scripts/run-tool.mjs supabase-rate-model.ts install --proposal-hash <confirmed-hash>
node <plugin-root>/scripts/run-tool.mjs supabase-rate-model.ts reload
```

The `confirm` command checks the current proposal hash. It does not save an operational profile. The human confirmation remains the required stop gate.

`install` uses migrations `20260912000100_acme_rate_model.sql`, `20260912000200_acme_rate_context_key.sql`, and `20260912000300_acme_rate_query_context.sql` with Supabase CLI `2.117.0`. It uses the explicit project reference. It never calls `supabase link` or `migration repair`.

The installer saves the confirmed profile only after these checks pass:

- the binding, objects, columns, constraints, grants, RLS policies, and dependencies match the proposal;
- both exposed views and both functions use invoker security;
- the ACME role can read and write ACME rows;
- a second role cannot disclose or change ACME rows;
- the second role cannot insert an ACME row, even with a forged ACME context;
- the complete policy probe rolls back.

A failed check leaves `self/supabase/migration-attempt.json`. Inspect live state before a human authorizes marker removal. A second `install` must apply no migration and must repeat the checks.

## Version 1.0 contract

Each profile contains:

- `binding`: the exact Heroes tenant key and 20-character Supabase project reference;
- `resources`: qualified table, view, and function names with local IDs;
- `operations`: one function for ingest, plus views for discovery and list access, all with the stable `rate-contract-1.0` shape;
- `fields`: exactly one structured physical path for each required semantic field;
- `controls`: database RLS, private grants, approval, current-catalog, validity, provenance, and idempotency declarations.

A field path is a column name or JSON Pointer. Raw SQL and SQL fragments are invalid. Resource names must include their schema.

Every operation must use invoker security and database RLS. Its tenant rule binds `tenant.key` to the valid `heroes.tenant_key` database context. It also names each table dependency. Every dependency must appear in the profile's RLS-protected table set. This prevents a view or function from declaring a safe contract while it bypasses table RLS. S4b must verify that each real database object matches this declaration.

The required semantic fields cover:

- tenant identity;
- rate card and rule identities;
- service, location, timeframe, asset, participant, and strategy applicability;
- charge key, amount, currency, basis, bounds, tiers, and conditions;
- source file, reference, and hash;
- approval status, actor, time, and content hash;
- Heroes catalog response hash and fetch time.

The idempotency declaration must combine tenant key, card ID, rule ID, and source hash on one named table. The ACME physical constraint also includes the charge key. This preserves distinct charges for one source rule. A repeat write returns the existing row without a row change. The approval rule requires a valid content hash. The current rule compares the saved catalog hash with the active Heroes catalog. The validity rule requires the saved timeframe to contain the query window.

## Closed failures

The parser rejects:

- an unsupported profile version or status;
- a tenant or project mismatch;
- a missing or duplicate semantic mapping, or two semantics that use one physical path;
- an unknown or unsuitable resource;
- a view or function without invoker security and explicit database-RLS tenant context;
- a missing mapped-table RLS declaration;
- a direct `PUBLIC`, `anon`, or `authenticated` grant;
- an incomplete grant declaration;
- incomplete approval, current, validity, provenance, or idempotency controls.

Canonical persistence uses mode `0600` and an atomic rename. A repeated save of the same confirmed profile produces identical bytes.

The fixtures under `scripts/heroes-tools/test/fixtures/` show two supported layouts. One uses flat columns. The other uses a document table with JSON Pointer paths. Both normalize to the same business contract.
