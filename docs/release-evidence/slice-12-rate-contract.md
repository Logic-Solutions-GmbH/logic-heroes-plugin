# Slice 12 — Heroes-shaped local rate contract

Date: 2026-08-13

Baseline commit: `2fdcb441321aa4147e9d834d96c9f6378dbc47de`

## Outcome

The canonical local store is the versioned `rate-catalog.json` contract. Each card is an `OFFER` shape. Each rule prices one Heroes service. CSV is a lossless import and export adapter.

Heroes supplies service keys, asset types, asset subtypes, offer roles, strategy keys, and strategy steps. The snapshot records OpenAPI version `0.1.243` and protects its normalized values with SHA-256.

The local contract adds charges, conditions, source evidence, approval, and the catalog reference. Charges support flat or tiered amounts, optional minimums, and optional maximums.

## Validation test

`node plugins/heroes-agent/scripts/setup-tools.mjs --check` passed:

- TypeScript type check: pass.
- Package tests: 24 passed, 0 failed.
- Helper integration: pass.
- Dependency audit: 0 vulnerabilities.

The tests prove:

- FCL, LCL, air, road, customs-charge, and storage fixtures use current Heroes service and asset values.
- Unknown catalog values, invalid charges, invalid dates, invalid evidence, and invalid approval fail.
- One complete result plus one unresolved result cannot return exit `0`.
- Two complete applicable rules are ambiguous. Price does not rank them.
- Repeatable locations, assets, timeframes, participants, and strategy facts control discovery.
- Empty applicability dimensions do not exclude a rule.
- CSV preserves all charges, timeframes, applicability, conditions, approval, and source evidence.
- A changed approved CSV export fails its approved-content hash.
- A changed Heroes snapshot fails its catalog hash.
- Import rejects archive collisions and keeps the prior index unchanged.
- The import transaction journal completes or rolls back interrupted commits.
- Malformed catalogs and invalid queries return exit `4`.

The Codex plugin validator passed. Both Claude strict validators passed. `git diff --check` passed. The portability scan passed across 69 tracked files.

## Live credential reuse

The read-only `sync-rate-catalog.ts` command used each existing peer workspace through the normal `self/.env` loader. Both tenant checks passed without credential rotation or overwrite.

Each tenant returned:

- 12 service keys;
- 20 asset types;
- 10 strategy templates;
- OpenAPI version `0.1.243`;
- catalog hash `49b501f07cf2c3f3f6360d70b260c1c44ade52eadeafd118fff4c619e7d95861`.

The command wrote only disposable catalog snapshots. It did not print or copy either secret. Both credential files remained mode `0600`. This evidence contains no credential value.

## Understanding test

Heroes controls offer discovery semantics because shared searches and journeys use its service keys and facet shapes. A local taxonomy would drift and could select a rate for the wrong service.

The local catalog controls provider prices and evidence because those values belong to the provider. They are not shared workflow or legal state.

A flat CSV cannot represent several services, charges, locations, assets, timeframes, participants, strategies, and conditions without repeated data or loss. The nested JSON contract keeps those relationships. CSV remains useful as a reviewed adapter.

Credential reuse proves the new client follows the existing tenant boundary. Secrets must stay outside release evidence because evidence is committed and public.
