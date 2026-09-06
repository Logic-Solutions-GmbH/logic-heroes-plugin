# Local rate catalog

The canonical local store is `self/rate-book/index/rate-catalog.json`. It uses contract version `1.0`.

One rate card resembles one Heroes `OFFER` journey. Each rate rule resembles one service within that offer. Heroes controls service keys, location roles, asset types, asset subtypes, participant roles, and strategy vocabulary. The local peer controls provider charges, conditions, source evidence, and approval.

## Prepare the Heroes catalog

Run this read-only command from each peer workspace:

```text
node <plugin-root>/scripts/run-tool.mjs sync-rate-catalog.ts
```

It uses the current `self/.env` credential. It writes `self/rate-book/index/heroes-catalog.json` with a response hash. It never writes or prints the credential.

The command reads service keys, assets, strategy templates, and offer-search role values. It requests asset subtypes separately for every asset type because that catalog is dependent.

## Import CSV

CSV is an adapter. It is not the authority. Place stable adapter CSV files in `self/rate-book/inbox/`, then run:

```text
node <plugin-root>/scripts/run-tool.mjs ingest-rates.ts --dry-run
node <plugin-root>/scripts/run-tool.mjs ingest-rates.ts --approve-by "<operator name>"
```

Each initial CSV row must be `draft`. The explicit `--approve-by` action records the human approval during import. Approved CSV exports include a content hash. The importer rejects a changed approved export.

Each CSV row describes one charge. Repeat `cardId` and `ruleId` to attach several charges to one rule. A charge uses either `amount` or `tiersJson`. It can also use `minimum` and `maximum`. The simple columns support common locations, validity, and one asset. The JSON columns preserve all timeframes, source evidence, and nested applicability during export and re-import.

The importer rejects:

- CSV files with no rate rows;
- malformed CSV structure, including unterminated quotes and non-empty excess columns;
- unknown Heroes service keys, asset types, asset subtypes, and roles;
- missing locations, charges, evidence, or approval data;
- non-positive amounts, invalid bounds, invalid tiers, and invalid currency codes;
- conflicting repeated card or rule data;
- duplicate card IDs already present in the local catalog.

Successfully imported files move to `processed/`. A dry run changes no file. Validation, duplicate, and write failures leave the source in `inbox/`.

## Discover one safe result

A rate is safe for automatic use only when one rule is complete, approved, current, and valid:

- `complete` means the query supplies every applicability fact required by the rule;
- `approved` means the card has a valid human approval and approved-content hash;
- `current` means the card references the active Heroes catalog snapshot;
- `valid` means the stored timeframe fully contains the requested date or timeframe.

Use Heroes offer facts in the query:

```text
node <plugin-root>/scripts/run-tool.mjs find-rate.ts \
  --service-key fcl_freight_forwarding \
  --origin NLRTM --dest USNYC \
  --asset-type container --asset-subtype 40HC \
  --date 2026-09-01 --json
```

For a single-location service, use `--location <code>:<role>`. Repeat `--location` for each extra location. Repeat `--asset <type>:<subtype>` for each extra asset. Repeat `--participant <tenant-key>:<role>` for each participant. Use `--strategy <key>` and `--strategy-step <step>` when a rule requires those facts. Each stored timeframe uses the Heroes offer-search `{from,to}` shape. The saved Heroes snapshot supplies all accepted role and strategy values.

Exit codes are stable:

- `0`: exactly one complete, approved, current, valid rule applies;
- `3`: no automatic result is available; no match, missing facts, and ambiguity require human judgment;
- `4`: the query or catalog is invalid;
- `2`: the rate index or Heroes catalog snapshot is missing.

The command never selects the cheapest candidate. It reports every required fact absent from the query. Two applicable complete rules are ambiguous and require human resolution. Stale and unapproved candidates remain visible with source evidence and `ineligibleReasons`, but they cannot support an automatic quote.

## Export CSV

Run:

```text
node <plugin-root>/scripts/run-tool.mjs export-rates.ts
```

The default output is `self/rate-book/index/rate-catalog.csv`. It contains one row per charge. Its JSON columns preserve locations, assets, participants, strategy, and conditions for re-import.

## Product boundary

Arbitrary-source extraction is not part of this contract slice. An agent can later extract pasted text, Excel, PDF, email, or OCR input into a reviewable draft. A human must approve that draft before import.

The local rate catalog is provider-owned pricing evidence. Heroes remains authoritative for shared workflow and legal state.
