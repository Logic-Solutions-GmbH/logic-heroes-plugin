# Rate catalog

Run `sync-rate-catalog.ts` first. It saves the current Heroes catalog under `index/` through this peer's existing credential.

Place draft adapter CSV files in `inbox/`. Run `ingest-rates.ts --dry-run`, then `ingest-rates.ts --approve-by "<operator name>"`. The canonical store is `index/rate-catalog.json`. Parsed sources move to `processed/`.

Run `find-rate.ts` with a Heroes `serviceKey` and all required offer facts. Exit `0` requires one complete, approved, current result. Exit `4` means missing facts, ambiguity, or invalid data. The command never chooses the cheapest candidate.

Run `export-rates.ts` when a CSV view is required. CSV is an import and export adapter, not the authority.
